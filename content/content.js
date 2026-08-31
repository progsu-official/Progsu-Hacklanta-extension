// ============================================================
// Progsu LinkedIn Outreach Assistant — Content Script
// ============================================================
// Injected into LinkedIn pages. Responsibilities:
//   1. Detect when the user is viewing a LinkedIn profile
//   2. Show a warning badge if the profile has already been contacted
//   3. Detect when a messaging composer opens
//   4. Paste the selected template into that composer in a way that
//      LinkedIn's own editor state picks up (so the Send button enables)
//   5. Track which profiles have been messaged
// ============================================================

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__progsuInjected) return;
  window.__progsuInjected = true;

  // ---- State ----
  let settings = {};
  let templates = [];
  let selectedTemplateId = null;

  let currentProfileUrl = '';
  let currentProfileName = '';
  let currentCompany = '';

  let toolbar = null;
  let activeBox = null;
  let alreadyContactedBanner = null;
  let lastAutoPasteKey = '';
  let scanTimer = null;
  let contactedMap = {};

  // Duplicate-outreach block. Two scopes, because they answer for different
  // things: the profile page the user is reading, and the conversation the
  // open composer belongs to (which is often somebody else entirely).
  let profileBlock = { url: '', blocked: false, details: null };
  let composerBlock = { key: '', blocked: false, details: null, pending: null, verdictFor: '' };
  let blockOverlay = null;
  let blockToastTimer = null;

  // LinkedIn ships several messaging layouts (full page, overlay bubble,
  // "Message" modal from a profile). Cast a wide net, then filter.
  // Superset of every selector that has ever worked here. Detection is
  // deliberately broad — findComposer() ranks the matches instead of relying
  // on one selector being right, because LinkedIn renames classes often.
  const COMPOSER_SELECTOR = [
    '.msg-form__contenteditable[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '[class*="msg-form"] div[contenteditable="true"]',
    '.msg-overlay-conversation-bubble div[contenteditable="true"]',
    '.msg-s-message-list-container ~ div div[contenteditable="true"]',
    'form[class*="msg"] div[contenteditable="true"]',
    'div[data-artdeco-is-focused] div[contenteditable="true"]',
    'footer div[contenteditable="true"]',
    'div[aria-label*="message" i][contenteditable="true"]',
    'div[aria-label*="write" i][contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder*="message" i]',
    'div[role="textbox"][contenteditable="true"]'
  ].join(', ');

  // Other rich-text editors on LinkedIn that must never be treated as a chat box.
  // Kept deliberately specific: a broad [class*="typeahead"] rule also matched
  // .msg-connections-typeahead, which WRAPS the real message composer.
  const EXCLUDE_SELECTOR = [
    '.search-global-typeahead',
    '.share-creation-state',
    '.share-box',
    '[class*="share-creation"]',
    '.comments-comment-box',
    '[class*="comments-comment"]'
  ].join(', ');

  // ---- Initialization ----
  init();

  async function init() {
    await loadSettings();
    await loadTemplates();
    await loadContactedMap();
    // Installed before the first scan: a composer that is already open when
    // the script loads must not get a window where typing is unguarded.
    installBlockGuards();
    observePageChanges();
    checkCurrentPage();
    scan();
  }

  // ---- Settings & templates from storage ----
  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res && res.success) settings = res.settings || {};
    } catch (e) { /* extension context may be invalid */ }
  }

  async function loadTemplates() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_TEMPLATES' });
      if (res && res.success) {
        templates = res.templates || [];
        if (!templates.some(t => t.id === selectedTemplateId)) selectedTemplateId = null;
      }
    } catch (e) { /* extension context may be invalid */ }
  }

  // ---- URL / page observation ----
  function observePageChanges() {
    let lastUrl = location.href;

    // LinkedIn is a SPA — watch for URL changes and for the composer mounting.
    // Mutations fire constantly here, so the scan is debounced.
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        cleanup();
        checkCurrentPage();
      }
      scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Polling fallback — LinkedIn can swap the composer in without a mutation
    // we catch, and the toolbar needs repositioning as the page moves.
    setInterval(scan, 1200);
    window.addEventListener('scroll', repositionFloaters, true);
    window.addEventListener('resize', repositionFloaters);
  }

  // Both floating elements are fixed on <body>, so both have to follow the
  // composer. The overlay especially: a block that drifts off the form is a
  // block that stops blocking.
  function repositionFloaters() {
    positionToolbar();
    positionBlockOverlay();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 250);
  }

  function checkCurrentPage() {
    if (isProfilePage(location.href)) {
      currentProfileUrl = normalizeProfileUrl(location.href);
      extractProfileInfo();
      checkIfContacted();
    }
  }

  function isProfilePage(url) {
    return /linkedin\.com\/in\/[^/]+/.test(url);
  }

  function normalizeProfileUrl(url) {
    const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
    return m ? 'https://www.linkedin.com/in/' + decodeURIComponent(m[1]).toLowerCase() : '';
  }

  // ---- Extract profile info from the page ----
  function extractProfileInfo() {
    // LinkedIn renders the top card late and re-renders it a few times,
    // so retry rather than betting everything on one timeout.
    let attempts = 0;
    const tryExtract = () => {
      attempts++;
      const nameEl = document.querySelector('h1.text-heading-xlarge') ||
                     document.querySelector('h1[class*="text-heading"]') ||
                     document.querySelector('.pv-top-card--list li:first-child') ||
                     document.querySelector('main h1') ||
                     document.querySelector('h1');
      const name = cleanText(nameEl);
      if (name) currentProfileName = name;

      const expEl = document.querySelector('.pv-top-card--experience-list-item') ||
                    document.querySelector('[aria-label="Current company"]') ||
                    document.querySelector('.pv-text-details__right-panel button[aria-label] span') ||
                    document.querySelector('.text-body-small.inline');
      const company = cleanText(expEl);
      if (company) currentCompany = company;

      if ((!currentProfileName || !currentCompany) && attempts < 6) {
        setTimeout(tryExtract, 700);
      }
    };
    tryExtract();
  }

  // ---- Check if profile was already contacted ----
  async function checkIfContacted() {
    const url = currentProfileUrl;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'CHECK_PROFILE',
        profileUrl: url
      });

      // The user can navigate away mid-lookup; a late answer about the
      // previous profile must not license messaging this one.
      if (url !== currentProfileUrl) return;

      const contacted = !!(res && res.success && res.contacted);
      profileBlock = { url, blocked: contacted, details: contacted ? res.details : null };

      if (contacted && settings.showBadge !== false) {
        showAlreadyContactedBanner(res.details);
      } else {
        removeAlreadyContactedBanner();
      }
    } catch (e) { /* ignore */ }
  }

  // ---- "Already Contacted" banner ----
  function showAlreadyContactedBanner(details) {
    removeAlreadyContactedBanner();

    alreadyContactedBanner = document.createElement('div');
    alreadyContactedBanner.id = 'progsu-contacted-banner';
    alreadyContactedBanner.innerHTML = `
      <div class="progsu-banner-inner">
        <div class="progsu-banner-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <div class="progsu-banner-text">
          <strong>Already Contacted</strong>
          <span>Messaged by <em>${escapeHtml(details.sentBy || 'a team member')}</em> on ${formatDate(details.dateSent)}</span>
        </div>
        <button class="progsu-banner-dismiss" type="button" title="Dismiss" aria-label="Dismiss already-contacted warning">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `;

    alreadyContactedBanner.querySelector('.progsu-banner-dismiss')
      .addEventListener('click', removeAlreadyContactedBanner);

    const mainContent = document.querySelector('main') || document.body;
    mainContent.prepend(alreadyContactedBanner);
  }

  function removeAlreadyContactedBanner() {
    if (alreadyContactedBanner) {
      alreadyContactedBanner.remove();
      alreadyContactedBanner = null;
    }
    const existing = document.getElementById('progsu-contacted-banner');
    if (existing) existing.remove();
  }

  // ============================================================
  // Duplicate outreach block
  // ============================================================
  // The banner above says someone already reached out. This stops you doing
  // it anyway. Every route that could produce a second message is sealed:
  // auto-paste, the Paste button, typing, clipboard paste, drag-and-drop,
  // LinkedIn's own Send button, and the Message button on a profile or a
  // search row.
  //
  // The verdict comes from the background worker, which asks the team's
  // Google Sheet before falling back to the local cache — so an outreach
  // logged on a teammate's laptop blocks this one within seconds rather
  // than at the next sync.

  function blockingEnabled() {
    return settings.blockDuplicates !== false;
  }

  /**
   * The region the guards seal off: the form the blocked composer lives in,
   * so the Send button and the attachment controls are covered too, not just
   * the text box. Falls back to the box for layouts with no .msg-form.
   */
  function blockedFormEl() {
    if (!composerBlock.blocked || !activeBox || !activeBox.isConnected) return null;
    return activeBox.closest('.msg-form, [class*="msg-form"], form[class*="msg"]') || activeBox;
  }

  /**
   * Decides whether the conversation this composer belongs to is off limits,
   * and returns a promise for that verdict.
   *
   * Returning the promise — and caching the in-flight one — is what lets
   * auto-paste wait for an answer instead of racing it. `composerBlock.blocked`
   * is still false while the sheet is being asked, so anything that reads the
   * flag synchronously would paste into a conversation about to be sealed.
   */
  function evaluateComposerBlock(box) {
    if (!blockingEnabled()) { clearComposerBlock(); return Promise.resolve(false); }

    const key = getRecipient(box).profileUrl || '';

    // No profile link means no reliable identity. Blocking on a guessed name
    // would refuse legitimate messages, so an unidentified conversation stays
    // warn-only — the marker and banner still do their job.
    if (!key) { clearComposerBlock(); return Promise.resolve(false); }

    // Already asked about this conversation. Re-asking on every scan pass
    // would be a sheet lookup twice a second.
    if (key === composerBlock.key) {
      return composerBlock.pending || Promise.resolve(composerBlock.blocked);
    }

    // A standing verdict about someone else is worthless here, so it goes.
    // A standing verdict about *this* person survives the re-check: dropping
    // it would unseal the composer for one round trip every time a sync or a
    // settings save invalidates the answer.
    if (key !== composerBlock.verdictFor) {
      composerBlock.blocked = false;
      composerBlock.details = null;
      removeBlockOverlay();
    }

    // Key first: resolveComposerBlock compares against it to tell its own
    // answer apart from a stale one after the await.
    composerBlock.key = key;
    composerBlock.pending = resolveComposerBlock(key);
    return composerBlock.pending;
  }

  async function resolveComposerBlock(key) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'CHECK_PROFILE', profileUrl: key });
    } catch (e) {
      return false; // extension context may be invalid
    }

    // The user can switch conversations while the sheet is answering; a late
    // verdict about the previous recipient must not be applied to this one.
    if (composerBlock.key !== key) return false;

    const blocked = !!(res && res.success && res.contacted);
    composerBlock.blocked = blocked;
    composerBlock.details = blocked ? res.details : null;
    composerBlock.verdictFor = key;
    composerBlock.pending = null;

    if (blocked) {
      showBlockOverlay(res.details);
    } else {
      removeBlockOverlay();
    }
    applyBlockToToolbar();
    return blocked;
  }

  function clearComposerBlock() {
    // scan() runs twice a second and reaches here on every pass whenever the
    // composer has no identifiable recipient, so an already-clear state must
    // not keep re-running the DOM sweep in removeBlockOverlay.
    if (!composerBlock.key && !composerBlock.blocked && !blockOverlay) return;
    composerBlock = { key: '', blocked: false, details: null, pending: null, verdictFor: '' };
    removeBlockOverlay();
  }

  function blockReason(details) {
    const who = (details && details.sentBy) || 'a teammate';
    return 'Blocked — ' + who + ' already reached out on ' + formatDate(details && details.dateSent);
  }

  // ---- Overlay covering the composer ----

  function showBlockOverlay(details) {
    removeBlockOverlay();

    const who = (details && details.sentBy) || 'a teammate';
    const when = formatDate(details && details.dateSent);

    blockOverlay = document.createElement('div');
    blockOverlay.id = 'progsu-block-overlay';
    blockOverlay.setAttribute('role', 'alert');
    blockOverlay.innerHTML = `
      <div class="progsu-block-card">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        <div class="progsu-block-text">
          <strong>Already contacted — messaging blocked</strong>
          <span>${escapeHtml(who)} reached out on ${escapeHtml(when)}. Turn off “Block duplicate outreach” in Progsu settings to override.</span>
        </div>
      </div>
    `;

    // The overlay sits on top of the form and takes the pointer events the
    // form would have got, which is what stops a click on Send.
    blockOverlay.addEventListener('mousedown', stopEvent, true);
    blockOverlay.addEventListener('click', stopEvent, true);

    document.body.appendChild(blockOverlay);
    positionBlockOverlay();
  }

  function removeBlockOverlay() {
    if (blockOverlay) { blockOverlay.remove(); blockOverlay = null; }
    document.querySelectorAll('#progsu-block-overlay').forEach(el => el.remove());
  }

  // Fixed on <body> like the toolbar, so it has to track the form it covers.
  function positionBlockOverlay() {
    if (!blockOverlay || !blockOverlay.isConnected) return;

    const form = blockedFormEl();
    if (!form || !isVisible(form)) { blockOverlay.style.visibility = 'hidden'; return; }

    const r = form.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { blockOverlay.style.visibility = 'hidden'; return; }

    blockOverlay.style.visibility = 'visible';
    blockOverlay.style.top = r.top + 'px';
    blockOverlay.style.left = r.left + 'px';
    blockOverlay.style.width = r.width + 'px';
    blockOverlay.style.height = Math.max(r.height, 60) + 'px';
  }

  // A refused keystroke is otherwise indistinguishable from a frozen page.
  function pulseBlockOverlay() {
    if (!blockOverlay) return;
    blockOverlay.classList.remove('progsu-block-pulse');
    void blockOverlay.offsetWidth; // reflow, so the animation restarts
    blockOverlay.classList.add('progsu-block-pulse');
  }

  function applyBlockToToolbar() {
    if (!toolbar || !toolbar.isConnected) return;
    const pasteBtn = toolbar.querySelector('.progsu-paste-btn');
    if (!pasteBtn) return;

    if (!composerBlock.blocked) {
      pasteBtn.disabled = templates.length === 0;
      pasteBtn.title = 'Paste template into chat';
      return;
    }

    pasteBtn.disabled = true;
    pasteBtn.title = 'Blocked — this person has already been contacted';
    setStatus(blockReason(composerBlock.details), 'error');
  }

  // ---- Event guards ----

  // Keys that navigate, dismiss, or delete rather than write. Swallowing
  // these would trap the user inside a box they are not allowed to type in —
  // and deletion can't send anything, so refusing it would only strand a
  // draft they had started before the verdict landed.
  const BLOCK_ALLOWED_KEYS = new Set([
    'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Alt', 'Meta',
    'Backspace', 'Delete'
  ]);

  function installBlockGuards() {
    // Capture phase throughout. LinkedIn's own handlers sit on the form and
    // on document, so a bubble-phase listener would run after the message
    // had already gone out.
    document.addEventListener('keydown', onGuardKeydown, true);
    document.addEventListener('beforeinput', onGuardInput, true);
    document.addEventListener('paste', onGuardInput, true);
    document.addEventListener('drop', onGuardInput, true);
    document.addEventListener('click', onGuardClick, true);
  }

  function inBlockedComposer(target) {
    const form = blockedFormEl();
    if (!form) return false;
    if (!target || typeof target.closest !== 'function') return false;
    // Our own controls sit inside the form's screen area but must stay usable.
    if (target.closest('#progsu-paste-toolbar, #progsu-block-overlay')) return false;
    return form.contains(target);
  }

  function onGuardKeydown(e) {
    if (!inBlockedComposer(e.target)) return;
    if (BLOCK_ALLOWED_KEYS.has(e.key)) return;
    // Copy and select-all take nothing out of the box that isn't already in it.
    if ((e.ctrlKey || e.metaKey) && /^[ac]$/i.test(e.key)) return;
    stopEvent(e);
  }

  function onGuardInput(e) {
    if (!inBlockedComposer(e.target)) return;
    // Same reasoning as the allowed keys: a deletion adds nothing to the box.
    // paste and drop events carry no inputType, so they always fall through.
    if (typeof e.inputType === 'string' && e.inputType.indexOf('delete') === 0) return;
    stopEvent(e);
  }

  function onGuardClick(e) {
    if (inBlockedComposer(e.target)) { stopEvent(e); return; }
    if (!blockingEnabled()) return;

    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;

    const btn = target.closest('button, a[role="button"], a[href*="/messaging/"]');
    if (!btn || !isMessageButton(btn)) return;

    const details = blockedDetailsFor(btn);
    if (!details) return;

    // Stopping the composer from opening at all is cheaper than opening it
    // and immediately covering it.
    stopEvent(e);
    showBlockToast(details);
    if (isProfilePage(location.href) && settings.showBadge !== false) {
      showAlreadyContactedBanner(details);
    }
  }

  function isMessageButton(el) {
    if (el.closest('#progsu-paste-toolbar, #progsu-block-overlay, #progsu-contacted-banner')) return false;
    const label = (el.getAttribute('aria-label') || '').trim();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    // "Message Jane Doe" on a profile, a bare "Message" in a list row.
    return /^message\b/i.test(label) || /^message$/i.test(text);
  }

  /** Who would this Message button write to, and are they off limits? */
  function blockedDetailsFor(btn) {
    if (isProfilePage(location.href)) {
      return (profileBlock.blocked && profileBlock.url === currentProfileUrl)
        ? profileBlock.details
        : null;
    }

    // In a list the button belongs to a row, and the row's /in/ link names
    // the person. Answered from the local cache: a list holds dozens of rows
    // and a sheet lookup per click is the wrong trade for a click guard.
    const row = btn.closest(MARKER_ROW_SELECTOR);
    const link = row && row.querySelector('a[href*="/in/"]');
    const url = link ? normalizeProfileUrl(link.href) : '';
    return url ? (contactedMap[url] || null) : null;
  }

  function stopEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    pulseBlockOverlay();
  }

  // ---- Toast, for blocks that happen away from the composer ----

  function showBlockToast(details) {
    let toast = document.getElementById('progsu-block-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'progsu-block-toast';
      toast.setAttribute('role', 'alert');
      document.body.appendChild(toast);
    }

    toast.innerHTML = `
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
      </svg>
      <span>${escapeHtml(blockReason(details))}</span>
    `;
    toast.classList.add('progsu-toast-visible');

    clearTimeout(blockToastTimer);
    blockToastTimer = setTimeout(() => {
      toast.classList.remove('progsu-toast-visible');
    }, 5000);
  }

  // ============================================================
  // Contact markers on profile links
  // ============================================================
  // Annotates the /in/ links LinkedIn has already drawn — search results,
  // My Network, connection lists, the feed — with a pill naming whoever on
  // the team reached out first. Deliberately passive: it reads what is on
  // screen and never scrolls or fetches to harvest more.

  // Anchored on href, never on class names. LinkedIn renames classes
  // constantly (see COMPOSER_SELECTOR above); the /in/ href is the part of
  // their markup that stays put.
  const PROFILE_LINK_SELECTOR = 'a[href*="/in/"]';

  // Links that point at a person but aren't a person in a list: our own UI
  // and the top nav. Kept narrow on purpose — a bare 'header' rule also
  // swallowed real result rows, and a missing marker defeats the feature
  // while a redundant one is only untidy.
  const MARKER_EXCLUDE_SELECTOR = [
    '#progsu-paste-toolbar',
    '#progsu-contacted-banner',
    '.global-nav',
    '.msg-form'
  ].join(', ');

  // Ancestors that represent "one person in a list", used to keep a row from
  // being stamped twice.
  const MARKER_ROW_SELECTOR = 'li, article, [data-view-name], .artdeco-entity-lockup';

  async function loadContactedMap() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_CONTACTED' });
      if (res && res.success) contactedMap = res.contactedProfiles || {};
    } catch (e) { /* extension context may be invalid */ }
  }

  function annotateProfileLinks() {
    if (settings.showMarkers === false) return;

    document.querySelectorAll(PROFILE_LINK_SELECTOR).forEach(link => {
      // The MutationObserver fires on our own injection, so a link we have
      // already considered must never be reconsidered — without this guard
      // annotating triggers a scan that annotates again, forever.
      if (link.dataset.progsuMarked) return;
      if (link.closest(MARKER_EXCLUDE_SELECTOR)) return;

      const url = normalizeProfileUrl(link.href);
      if (!url) return;

      link.dataset.progsuMarked = '1';

      const details = contactedMap[url];
      if (!details) return;

      // LinkedIn points the avatar and the name at the same profile, so a row
      // holds two or three links per person. Skip the image-only ones, then
      // skip anything in a row already carrying a pill.
      if (!(link.textContent || '').trim()) return;

      const row = link.closest(MARKER_ROW_SELECTOR) || link.parentElement;
      if (row && row.querySelector('[data-progsu-marker]')) return;

      link.appendChild(buildMarker(details));
    });
  }

  function buildMarker(details) {
    const who = details.sentBy || 'a team member';
    const label = 'Contacted by ' + who + ' on ' + formatDate(details.dateSent) +
                  (details.templateUsed ? ' · ' + details.templateUsed : '');

    const marker = document.createElement('span');
    marker.className = 'progsu-contact-marker';
    marker.dataset.progsuMarker = '1';
    marker.title = label;
    // The pill lives inside LinkedIn's name link, so without this a screen
    // reader folds "Sam" into the link text and announces "Jane Doe Sam".
    // role="img" + aria-label makes it one labelled unit instead.
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', label);
    marker.innerHTML =
      '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="20 6 9 17 4 12"/></svg>' +
      '<span>' + escapeHtml(firstNameOf(who)) + '</span>';
    return marker;
  }

  function firstNameOf(name) {
    const first = String(name || '').trim().split(/\s+/)[0] || 'team';
    return first.length > 12 ? first.slice(0, 12) + '\u2026' : first;
  }

  // Marking a link records that it was *considered*, contacted or not, so a
  // newly contacted profile would keep its stale "not contacted" verdict.
  // Any change to the list therefore clears every verdict and starts over.
  function refreshMarkers() {
    document.querySelectorAll('[data-progsu-marker]').forEach(el => el.remove());
    document.querySelectorAll('[data-progsu-marked]').forEach(el => {
      delete el.dataset.progsuMarked;
    });
    annotateProfileLinks();
  }

  // Fires when the popup marks someone, removes an entry, or imports a
  // teammate's list — the lists on screen update without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.contactedProfiles) {
      contactedMap = changes.contactedProfiles.newValue || {};
      refreshMarkers();
      if (currentProfileUrl) checkIfContacted();

      // A sync that pulls in a teammate's outreach has to seal the composer
      // that is already open, so the standing verdict is thrown away and
      // asked again on the next scan.
      composerBlock.key = '';
      if (activeBox && activeBox.isConnected) evaluateComposerBlock(activeBox).catch(() => {});
    }

    if (changes.settings) {
      settings = changes.settings.newValue || {};
      refreshMarkers();
      // Blocking may have just been switched off — or on, over a composer
      // that is already open.
      composerBlock.key = '';
      if (activeBox && activeBox.isConnected) evaluateComposerBlock(activeBox).catch(() => {});
      else clearComposerBlock();
    }
  });

  // ============================================================
  // Composer detection
  // ============================================================

  function isComposer(el) {
    if (!el || el.getAttribute('contenteditable') !== 'true') return false;
    if (el.closest(EXCLUDE_SELECTOR)) return false;

    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('aria-placeholder'),
      el.getAttribute('data-placeholder'),
      el.getAttribute('placeholder')
    ].filter(Boolean).join(' ').toLowerCase();

    if (label.includes('search')) return false;
    // Anything else that survived the selector list and the exclusions is
    // treated as a candidate; findComposer() ranks them.
    return true;
  }

  // Higher score = more likely to be the composer the user is looking at.
  function composerScore(el) {
    let score = 0;
    if (el === document.activeElement || el.contains(document.activeElement)) score += 100;
    if (el.closest('.msg-form, [class*="msg-form"], .msg-overlay-conversation-bubble, [class*="msg-convo"], form[class*="msg"]')) score += 50;
    if (el.classList.contains('msg-form__contenteditable')) score += 25;
    const label = (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').toLowerCase();
    if (label.includes('message') || label.includes('write')) score += 10;
    if (el.closest('.msg-overlay-conversation-bubble--is-minimized')) score -= 40;
    return score;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 8) return false;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (parseFloat(st.opacity || '1') === 0) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  // Pick the composer the user is actually looking at, not just the last
  // element that happens to match a selector.
  function findComposer() {
    const candidates = [];
    document.querySelectorAll(COMPOSER_SELECTOR).forEach(el => {
      if (isComposer(el) && isVisible(el) && candidates.indexOf(el) === -1) candidates.push(el);
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    let best = candidates[0];
    let bestScore = composerScore(best);
    for (let i = 1; i < candidates.length; i++) {
      // >= so that, on a tie, the most recently opened chat wins
      const sc = composerScore(candidates[i]);
      if (sc >= bestScore) { best = candidates[i]; bestScore = sc; }
    }
    return best;
  }

  // Runs on mutations, on a timer, and after navigation.
  function scan() {
    annotateProfileLinks();

    const box = findComposer();

    if (!box) {
      if (toolbar) removeToolbar();
      clearComposerBlock();
      activeBox = null;
      return;
    }

    // Re-attach when the composer changed OR when a LinkedIn re-render tore
    // our toolbar out of the DOM.
    if (box !== activeBox || !toolbar || !toolbar.isConnected) {
      activeBox = box;
      attachToolbar(box);
    }

    // Runs before auto-paste, and auto-paste re-checks the verdict itself —
    // the lookup is asynchronous, so "asked first" is not "answered first".
    evaluateComposerBlock(box).catch(() => {});

    repositionFloaters();
    maybeAutoPaste(box).catch(() => {});
  }

  // ============================================================
  // Recipient info (works on the messaging page, not just profiles)
  // ============================================================

  function getRecipient(box) {
    try {
      return getRecipientUnsafe(box);
    } catch (e) {
      // A selector miss must not take down auto-paste or Mark Sent
      return { name: currentProfileName || '', profileUrl: currentProfileUrl || '', company: '' };
    }
  }

  function getRecipientUnsafe(box) {
    if (isProfilePage(location.href) && currentProfileName) {
      return { name: currentProfileName, profileUrl: currentProfileUrl, company: currentCompany };
    }

    const bubble = box && (
      box.closest('.msg-overlay-conversation-bubble') ||
      box.closest('.msg-convo-wrapper') ||
      box.closest('[class*="msg-convo"]')
    );
    const scope = bubble || document.querySelector('.msg-title-bar') || document;
    const scoped = scope !== document;

    let name = '';
    const nameSelectors = [
      '.msg-overlay-bubble-header__title',
      '.msg-entity-lockup__entity-title',
      'a.msg-thread__link-to-profile',
      '.msg-title-bar h2',
      'h2[class*="entity-title"]'
    ];
    for (const sel of nameSelectors) {
      const t = cleanText(scope.querySelector(sel));
      if (t) { name = t; break; }
    }

    let profileUrl = '';
    const linkSelectors = [
      'a.msg-thread__link-to-profile[href*="/in/"]',
      '.msg-overlay-bubble-header a[href*="/in/"]',
      '.msg-entity-lockup a[href*="/in/"]',
      '.msg-title-bar a[href*="/in/"]'
    ];
    // A bare a[href*="/in/"] is only safe inside a conversation container —
    // on the full messaging page it would match the conversation list instead.
    if (scoped) linkSelectors.push('a[href*="/in/"]');

    for (const sel of linkSelectors) {
      const el = scope.querySelector(sel);
      if (el && el.href) {
        profileUrl = normalizeProfileUrl(el.href);
        if (profileUrl) break;
      }
    }

    if (!name && profileUrl) name = slugToName(profileUrl);
    if (!name) name = currentProfileName;
    if (!profileUrl) profileUrl = currentProfileUrl;

    return { name: name || '', profileUrl: profileUrl || '', company: '' };
  }

  function conversationKey(box) {
    const r = getRecipient(box);
    return r.profileUrl || r.name || location.pathname;
  }

  // ============================================================
  // Paste toolbar (floating, so LinkedIn re-renders can't destroy it)
  // ============================================================

  function attachToolbar(box) {
    removeToolbar();

    toolbar = document.createElement('div');
    toolbar.id = 'progsu-paste-toolbar';

    const hasTemplates = templates.length > 0;
    const chosen = currentTemplate();

    toolbar.innerHTML = `
      <div class="progsu-toolbar-inner">
        <div class="progsu-toolbar-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <span>Progsu</span>
        </div>
        <select class="progsu-template-select"${hasTemplates ? '' : ' disabled'}>
          ${hasTemplates
            ? templates.map(t => `<option value="${escapeHtml(t.id)}"${chosen && t.id === chosen.id ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('')
            : '<option>No templates yet</option>'}
        </select>
        <button class="progsu-paste-btn"${hasTemplates ? '' : ' disabled'} title="Paste template into chat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Paste Message
        </button>
        <button class="progsu-mark-btn" title="Mark profile as contacted">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Mark Sent
        </button>
      </div>
      <div class="progsu-toolbar-status" hidden></div>
    `;

    document.body.appendChild(toolbar);

    const selectEl = toolbar.querySelector('.progsu-template-select');
    const pasteBtn = toolbar.querySelector('.progsu-paste-btn');
    const markBtn = toolbar.querySelector('.progsu-mark-btn');

    // Keep the caret inside the composer when a toolbar button is clicked —
    // the paste path needs a live selection in the editable element.
    [pasteBtn, markBtn].forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault());
    });

    selectEl.addEventListener('change', () => { selectedTemplateId = selectEl.value; });

    pasteBtn.addEventListener('click', async () => {
      const template = templates.find(t => t.id === selectEl.value) || currentTemplate();
      if (!template) { setStatus('No template selected', 'error'); return; }

      const target = (activeBox && activeBox.isConnected) ? activeBox : findComposer();
      if (!target) { setStatus('Could not find the message box — click into the chat', 'error'); return; }
      activeBox = target;

      if (await evaluateComposerBlock(target)) {
        setStatus(blockReason(composerBlock.details), 'error');
        pulseBlockOverlay();
        return;
      }

      if (pasteTemplate(target, template)) {
        flashButton(pasteBtn, '✓ Pasted!');
        setStatus('', '');
      } else {
        setStatus('LinkedIn blocked the paste — click inside the chat box, then retry', 'error');
      }
    });

    markBtn.addEventListener('click', async () => {
      const template = templates.find(t => t.id === selectEl.value) || currentTemplate();
      const recipient = getRecipient(activeBox);

      // Always record something. Preferring the recipient's profile URL keeps
      // duplicate detection accurate, but a missing link must never mean
      // "do nothing" — that silently loses the user's outreach history.
      const profileUrl = recipient.profileUrl ||
                         currentProfileUrl ||
                         normalizeProfileUrl(location.href) ||
                         location.href;
      const isProfileLink = /linkedin\.com\/in\//i.test(profileUrl);

      try {
        await chrome.runtime.sendMessage({
          type: 'MARK_CONTACTED',
          profileUrl: profileUrl,
          name: recipient.name || currentProfileName || 'Unknown',
          templateName: template ? template.name : 'Unknown',
          sentBy: settings.teamName || 'Team Member'
        });
        flashButton(markBtn, '✓ Marked!');
        setStatus(isProfileLink
          ? ''
          : 'Saved, but no profile link was found here — open their profile to link it properly.',
          isProfileLink ? '' : 'warn');
      } catch (e) {
        setStatus('Could not save — try reloading the page', 'error');
      }
    });

    positionToolbar();
    // A rebuilt toolbar starts with a live Paste button, so a standing block
    // has to be re-applied to it.
    applyBlockToToolbar();
    showContactedChip(box);
  }

  function currentTemplate() {
    return templates.find(t => t.id === selectedTemplateId) ||
           templates.find(t => t.isDefault) ||
           templates[0] ||
           null;
  }

  function removeToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
    document.querySelectorAll('#progsu-paste-toolbar').forEach(el => el.remove());
  }

  // The toolbar is position:fixed on <body>, so it has to track the composer.
  function positionToolbar() {
    if (!toolbar || !toolbar.isConnected) return;
    if (!activeBox || !activeBox.isConnected || !isVisible(activeBox)) {
      toolbar.style.visibility = 'hidden';
      return;
    }

    const anchor = activeBox.closest('.msg-form') || activeBox;
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      toolbar.style.visibility = 'hidden';
      return;
    }

    toolbar.style.visibility = 'visible';
    const h = toolbar.offsetHeight || 42;
    let top = r.top - h - 6;
    if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - h - 8);

    toolbar.style.top = Math.max(8, top) + 'px';
    toolbar.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
    toolbar.style.width = Math.max(280, Math.min(r.width, window.innerWidth - 16)) + 'px';
  }

  function setStatus(text, kind) {
    if (!toolbar) return;
    const el = toolbar.querySelector('.progsu-toolbar-status');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
    const mod = kind === 'error' ? ' progsu-status-error'
              : kind === 'warn'  ? ' progsu-status-warn'
              : '';
    el.className = 'progsu-toolbar-status' + mod;
  }

  function flashButton(btn, label) {
    if (!btn || btn.dataset.progsuFlashing === '1') return;
    const original = btn.innerHTML;
    btn.dataset.progsuFlashing = '1';
    btn.textContent = label;
    btn.classList.add('progsu-btn-success');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.innerHTML = original;
      btn.classList.remove('progsu-btn-success');
      btn.dataset.progsuFlashing = '0';
    }, 1600);
  }

  async function showContactedChip(box) {
    const recipient = getRecipient(box);
    if (!recipient.profileUrl || settings.showBadge === false) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_PROFILE', profileUrl: recipient.profileUrl });
      // The block message says the same thing more firmly; don't overwrite it.
      if (composerBlock.blocked) return;
      if (res && res.success && res.contacted && toolbar) {
        setStatus('⚠ Already contacted by ' + (res.details.sentBy || 'a team member') +
                  ' on ' + formatDate(res.details.dateSent), 'error');
      }
    } catch (e) { /* ignore */ }
  }

  // ============================================================
  // Paste engine
  // ============================================================

  function renderTemplate(body, box) {
    const recipient = getRecipient(box || activeBox);
    const name = recipient.name || currentProfileName || '';
    const parts = name.split(' ').filter(Boolean);

    const firstName = parts[0] || '{{firstName}}';
    const lastName = parts.slice(1).join(' ') || '{{lastName}}';
    const fullName = name || '{{fullName}}';
    const company = recipient.company || currentCompany || '{{company}}';

    return String(body || '')
      .replace(/\{\{\s*firstName\s*\}\}/gi, firstName)
      .replace(/\{\{\s*lastName\s*\}\}/gi, lastName)
      .replace(/\{\{\s*fullName\s*\}\}/gi, fullName)
      .replace(/\{\{\s*company\s*\}\}/gi, company);
  }

  function pasteTemplate(box, template) {
    const text = renderTemplate(template.body, box);
    if (!text) return false;

    box.focus({ preventScroll: true });

    // Try progressively less "native" strategies, verifying after each one.
    // Strategy 1 is the important one: execCommand produces the browser's own
    // beforeinput/input events, which is what LinkedIn's editor listens to.
    // Writing innerHTML directly (the old behaviour) leaves LinkedIn's state
    // empty, which is why the message looked pasted but Send stayed disabled.
    const ok = insertViaExecCommand(box, text) ||
               insertViaPasteEvent(box, text) ||
               insertViaDom(box, text);

    if (ok) {
      hidePlaceholder(box);
      placeCaretAtEnd(box);
      enableSendButton(box);
    }
    return ok;
  }

  // Strategy 1 — native editing commands.
  function insertViaExecCommand(box, text) {
    try {
      selectAllIn(box);
      if (normalizeText(boxText(box)) !== '') document.execCommand('delete', false, null);

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && !document.execCommand('insertParagraph', false, null)) {
          document.execCommand('insertLineBreak', false, null);
        }
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }
      return wasWritten(box, text);
    } catch (e) {
      return false;
    }
  }

  // Strategy 2 — a synthetic paste event. Editors that handle paste in JS
  // (Quill and friends) read the DataTransfer and insert the text themselves.
  function insertViaPasteEvent(box, text) {
    try {
      selectAllIn(box);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      dt.setData('text/html', text.split(/\r?\n/)
        .map(l => '<p>' + (l ? escapeHtml(l) : '<br>') + '</p>').join(''));
      box.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt
      }));
      return wasWritten(box, text);
    } catch (e) {
      return false;
    }
  }

  // Strategy 3 — write the DOM ourselves and fire a full event sequence.
  function insertViaDom(box, text) {
    try {
      const lines = text.split(/\r?\n/);
      box.innerHTML = '';
      lines.forEach(line => {
        const p = document.createElement('p');
        if (line) p.textContent = line;
        else p.appendChild(document.createElement('br'));
        box.appendChild(p);
      });

      box.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: text
      }));
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, inputType: 'insertText', data: text
      }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
      box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));

      return wasWritten(box, text);
    } catch (e) {
      return false;
    }
  }

  // LinkedIn's placeholder is a sibling overlay; it only clears itself when the
  // editor's own state updates, so hide it if it lingered after a fallback.
  function hidePlaceholder(box) {
    const form = box.closest('.msg-form') || box.closest('[class*="msg-form"]') || box.parentElement;
    if (!form) return;
    form.querySelectorAll('.msg-form__placeholder, [class*="placeholder"]').forEach(el => {
      if (el !== box && !el.contains(box)) el.style.display = 'none';
    });
  }

  // Safety net for the fallback strategies: if the composer has text but
  // LinkedIn still thinks it is empty, un-disable Send so the user isn't stuck.
  function enableSendButton(box) {
    setTimeout(() => {
      if (!box.isConnected || normalizeText(boxText(box)) === '') return;
      const form = box.closest('.msg-form') || box.closest('[class*="msg-form"]') ||
                   box.closest('form') || box.closest('.msg-overlay-conversation-bubble');
      if (!form) return;
      form.querySelectorAll('button.msg-form__send-button, button[type="submit"], button[class*="send-button"]')
        .forEach(btn => {
          if (btn.disabled) {
            btn.disabled = false;
            btn.removeAttribute('disabled');
            btn.classList.remove('artdeco-button--disabled');
          }
        });
    }, 150);
  }

  async function maybeAutoPaste(box) {
    if (!settings.autoPaste) return;
    const template = currentTemplate();
    if (!template) return;
    if (!isBoxEmpty(box)) return;

    // Keyed by conversation so a React re-render doesn't re-paste on a loop.
    // Falls back to the pathname so a failed recipient lookup can't disable it.
    const key = conversationKey(box) || location.pathname || 'progsu-default';
    if (key === lastAutoPasteKey) return;
    lastAutoPasteKey = key;

    // Auto-paste is the one path that fires without the user asking, so it
    // waits for the verdict rather than reading a flag that is still false
    // because the sheet has not answered yet.
    if (await evaluateComposerBlock(box)) return;

    setTimeout(() => {
      if (!box.isConnected || !isBoxEmpty(box)) return;
      // Re-checked on the way out: the verdict can land during the delay.
      if (composerBlock.blocked) return;
      pasteTemplate(box, template);
    }, 600);
  }

  function isBoxEmpty(box) {
    return normalizeText(boxText(box)) === '';
  }

  // ---- Selection / text helpers ----
  function selectAllIn(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }
  }

  function placeCaretAtEnd(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }
  }

  function boxText(box) {
    return box.innerText != null ? box.innerText : box.textContent;
  }

  function normalizeText(s) {
    return String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function wasWritten(box, text) {
    const got = normalizeText(boxText(box));
    const want = normalizeText(text);
    if (!want) return true;
    return got === want || got.indexOf(want) !== -1;
  }

  // ---- Cleanup on page navigation ----
  function cleanup() {
    removeToolbar();
    removeAlreadyContactedBanner();
    clearComposerBlock();
    profileBlock = { url: '', blocked: false, details: null };
    activeBox = null;
    lastAutoPasteKey = '';
    currentProfileUrl = '';
    currentProfileName = '';
    currentCompany = '';
  }

  // ---- Utilities ----
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function cleanText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.visually-hidden, [aria-hidden="true"], svg').forEach(n => n.remove());
    return (clone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*[·•]\s*(1st|2nd|3rd\+?)\s*$/i, '')
      .trim();
  }

  function slugToName(profileUrl) {
    const m = String(profileUrl).match(/\/in\/([^/?#]+)/);
    if (!m) return '';
    return decodeURIComponent(m[1])
      .split('-')
      .filter(p => p && !/\d/.test(p))
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  function formatDate(isoString) {
    if (!isoString) return 'unknown date';
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---- Diagnostic: run progsuDebug() in the console on a LinkedIn tab ----
  window.progsuDebug = function () {
    const all = document.querySelectorAll('div[contenteditable="true"]');
    const matched = document.querySelectorAll(COMPOSER_SELECTOR);
    const candidates = [];
    matched.forEach(el => {
      candidates.push({
        cls: (el.className || '(none)').toString().slice(0, 60),
        label: el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '',
        isComposer: isComposer(el),
        visible: isVisible(el),
        score: isComposer(el) && isVisible(el) ? composerScore(el) : null,
        excludedBy: el.closest(EXCLUDE_SELECTOR) ? (el.closest(EXCLUDE_SELECTOR).className || '').toString().slice(0, 40) : null
      });
    });
    const chosen = findComposer();
    const info = {
      url: location.href,
      contentEditablesOnPage: all.length,
      matchedBySelectors: matched.length,
      candidates: candidates,
      chosenComposer: chosen ? (chosen.className || '(no class)').toString().slice(0, 60) : 'NONE FOUND',
      toolbarPresent: !!document.getElementById('progsu-paste-toolbar'),
      templatesLoaded: templates.length,
      settings: settings,
      recipient: getRecipient(chosen)
    };
    console.log('%c[Progsu diagnostic]', 'color:#818CF8;font-weight:bold', info);
    return info;
  };

  // ---- Messages from the popup ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'SETTINGS_UPDATED') {
      loadSettings();
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'TEMPLATES_UPDATED') {
      loadTemplates().then(() => {
        // Rebuild the toolbar so its dropdown reflects the new template list
        if (activeBox && activeBox.isConnected) attachToolbar(activeBox);
      });
      sendResponse({ success: true });
      return true;
    }

    if (msg.type === 'PASTE_TEMPLATE_NOW') {
      const box = (activeBox && activeBox.isConnected) ? activeBox : findComposer();
      if (!box) {
        sendResponse({ success: false, error: 'No LinkedIn message box found — open a chat first' });
        return true;
      }
      activeBox = box;

      const template = msg.template || currentTemplate();
      if (!template) {
        sendResponse({ success: false, error: 'No template to paste' });
        return true;
      }

      evaluateComposerBlock(box).then(blocked => {
        if (blocked) {
          sendResponse({ success: false, error: blockReason(composerBlock.details) });
          return;
        }

        // The popup holds focus while it is open, and the native paste path
        // needs the page focused. Paste now if we can, otherwise when focus
        // returns.
        if (document.hasFocus()) {
          const ok = pasteTemplate(box, template);
          sendResponse(ok
            ? { success: true }
            : { success: false, error: 'LinkedIn blocked the paste — click inside the chat box and retry' });
          return;
        }

        let ran = false;
        const run = () => {
          if (ran || !box.isConnected) return;
          ran = true;
          // The verdict can change while we wait for focus to come back.
          if (composerBlock.blocked) { pulseBlockOverlay(); return; }
          pasteTemplate(box, template);
        };
        window.addEventListener('focus', () => setTimeout(run, 80), { once: true });
        setTimeout(run, 2500);
        sendResponse({ success: true });
      });
      return true;
    }

    return false;
  });
})();
