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

  // LinkedIn ships several messaging layouts (full page, overlay bubble,
  // "Message" modal from a profile). Cast a wide net, then filter.
  const COMPOSER_SELECTOR = [
    '.msg-form__contenteditable[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    '[class*="msg-form"] div[contenteditable="true"]',
    '.msg-overlay-conversation-bubble div[contenteditable="true"]',
    'form[class*="msg"] div[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"][aria-label*="message" i]',
    'div[role="textbox"][contenteditable="true"][aria-label*="write" i]',
    'div[contenteditable="true"][data-placeholder*="message" i]'
  ].join(', ');

  // Other rich-text editors on LinkedIn that must never be treated as a chat box
  const EXCLUDE_SELECTOR = [
    '.search-global-typeahead',
    '[class*="typeahead"]',
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
    window.addEventListener('scroll', positionToolbar, true);
    window.addEventListener('resize', positionToolbar);
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
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'CHECK_PROFILE',
        profileUrl: currentProfileUrl
      });

      if (res && res.success && res.contacted && settings.showBadge !== false) {
        showAlreadyContactedBanner(res.details);
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
        <button class="progsu-banner-dismiss" title="Dismiss">✕</button>
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
    if (el.closest('.msg-form, [class*="msg-form"], .msg-overlay-conversation-bubble, [class*="msg-convo"], form[class*="msg"]')) {
      return true;
    }
    return label.includes('message');
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

    const focused = candidates.find(el => el === document.activeElement || el.contains(document.activeElement));
    if (focused) return focused;

    const expanded = candidates.filter(el => !el.closest('.msg-overlay-conversation-bubble--is-minimized'));
    const pool = expanded.length ? expanded : candidates;
    return pool[pool.length - 1];
  }

  // Runs on mutations, on a timer, and after navigation.
  function scan() {
    const box = findComposer();

    if (!box) {
      if (toolbar) removeToolbar();
      activeBox = null;
      return;
    }

    // Re-attach when the composer changed OR when a LinkedIn re-render tore
    // our toolbar out of the DOM.
    if (box !== activeBox || !toolbar || !toolbar.isConnected) {
      activeBox = box;
      attachToolbar(box);
    }

    positionToolbar();
    maybeAutoPaste(box);
  }

  // ============================================================
  // Recipient info (works on the messaging page, not just profiles)
  // ============================================================

  function getRecipient(box) {
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

    pasteBtn.addEventListener('click', () => {
      const template = templates.find(t => t.id === selectEl.value) || currentTemplate();
      if (!template) { setStatus('No template selected', 'error'); return; }

      const target = (activeBox && activeBox.isConnected) ? activeBox : findComposer();
      if (!target) { setStatus('Could not find the message box — click into the chat', 'error'); return; }
      activeBox = target;

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

      if (!recipient.profileUrl) {
        setStatus('No profile link found for this chat — open their profile to mark it', 'error');
        return;
      }

      try {
        await chrome.runtime.sendMessage({
          type: 'MARK_CONTACTED',
          profileUrl: recipient.profileUrl,
          name: recipient.name || 'Unknown',
          templateName: template ? template.name : 'Unknown',
          sentBy: settings.teamName || 'Team Member'
        });
        flashButton(markBtn, '✓ Marked!');
        setStatus('', '');
      } catch (e) {
        setStatus('Could not save — try reloading the page', 'error');
      }
    });

    positionToolbar();
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
    el.className = 'progsu-toolbar-status' + (kind === 'error' ? ' progsu-status-error' : '');
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

  function maybeAutoPaste(box) {
    if (!settings.autoPaste) return;
    const template = currentTemplate();
    if (!template) return;
    if (!isBoxEmpty(box)) return;

    // Keyed by conversation so a React re-render doesn't re-paste on a loop.
    const key = conversationKey(box);
    if (!key || key === lastAutoPasteKey) return;
    lastAutoPasteKey = key;

    setTimeout(() => {
      if (box.isConnected && isBoxEmpty(box)) pasteTemplate(box, template);
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

      // The popup holds focus while it is open, and the native paste path needs
      // the page focused. Paste now if we can, otherwise when focus returns.
      if (document.hasFocus()) {
        const ok = pasteTemplate(box, template);
        sendResponse(ok
          ? { success: true }
          : { success: false, error: 'LinkedIn blocked the paste — click inside the chat box and retry' });
      } else {
        let ran = false;
        const run = () => {
          if (ran || !box.isConnected) return;
          ran = true;
          pasteTemplate(box, template);
        };
        window.addEventListener('focus', () => setTimeout(run, 80), { once: true });
        setTimeout(run, 2500);
        sendResponse({ success: true });
      }
      return true;
    }

    return false;
  });
})();
