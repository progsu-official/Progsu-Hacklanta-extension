// ============================================================
// Progsu LinkedIn Outreach Assistant — Google Sheet client
// ============================================================
// Talks to the Apps Script Web App deployed against the team's
// Google Sheet (see sheets/Code.gs). One sheet, many installs:
// whoever reaches out first owns the row, and every other copy of
// the extension learns to stay away.
//
// Transport notes:
//   * Requests go out as text/plain. That is a CORS-safelisted
//     content type, so the browser sends no preflight — which
//     matters because Apps Script cannot answer an OPTIONS request.
//     Apps Script reads the raw body out of e.postData.contents and
//     parses the JSON itself.
//   * Apps Script answers a /exec call with a 302 to
//     script.googleusercontent.com. fetch follows it, so both hosts
//     have to be in host_permissions.
// ============================================================

const DEFAULT_CONFIG = {
  url: '',            // the Apps Script /exec URL
  token: '',          // shared secret, must match SHARED_TOKEN in Code.gs
  enabled: false,
  syncMinutes: 5
};

const REQUEST_TIMEOUT_MS = 12000;

// ---- Config -------------------------------------------------------

export async function getSheetConfig() {
  const { sheetConfig } = await chrome.storage.local.get('sheetConfig');
  return { ...DEFAULT_CONFIG, ...(sheetConfig || {}) };
}

export async function saveSheetConfig(patch) {
  const next = { ...(await getSheetConfig()), ...(patch || {}) };
  next.url = String(next.url || '').trim();
  next.token = String(next.token || '').trim();
  next.syncMinutes = Math.max(1, Number(next.syncMinutes) || DEFAULT_CONFIG.syncMinutes);
  // "Enabled" without a URL would leave every call failing silently and
  // the status panel claiming the team sheet is live.
  next.enabled = !!next.enabled && !!next.url;
  await chrome.storage.local.set({ sheetConfig: next });
  return next;
}

export function isConfigured(config) {
  return !!(config && config.enabled && config.url);
}

// ---- Transport ----------------------------------------------------

async function call(config, payload) {
  if (!config || !config.url) {
    return { ok: false, error: 'No Google Sheet URL configured' };
  }

  const controller = new AbortController();
  // Without this a sleeping Apps Script deployment would hang the paste
  // guard indefinitely; a slow sheet has to degrade, not block.
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      // Deliberately text/plain — see the transport note at the top.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, token: config.token || '' }),
      redirect: 'follow',
      signal: controller.signal
    });

    const text = await res.text();

    if (!res.ok) {
      return { ok: false, error: 'Sheet returned HTTP ' + res.status };
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      // Apps Script serves an HTML sign-in or error page when the
      // deployment is private or the URL points at /dev instead of /exec.
      return {
        ok: false,
        error: /<html/i.test(text)
          ? 'Got a Google login page instead of data — redeploy the web app with access set to "Anyone", and use the /exec URL'
          : 'Sheet sent back something that was not JSON'
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: e.name === 'AbortError'
        ? 'Sheet did not answer in time'
        : 'Could not reach the sheet: ' + (e.message || String(e))
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Actions ------------------------------------------------------

export function sheetPing(config) {
  return call(config, { action: 'ping' });
}

/** `since` is an ISO timestamp; omit it for a full pull. */
export function sheetList(config, since) {
  return call(config, since ? { action: 'list', since } : { action: 'list' });
}

export function sheetCheck(config, profileUrl) {
  return call(config, { action: 'check', profileUrl });
}

export function sheetMark(config, entry) {
  return call(config, {
    action: 'mark',
    profileUrl: entry.profileUrl,
    name: entry.name,
    dateSent: entry.dateSent,
    sentBy: entry.sentBy,
    templateUsed: entry.templateUsed
  });
}

export function sheetBulk(config, entries) {
  return call(config, { action: 'bulk', entries });
}

export function sheetRemove(config, profileUrl) {
  return call(config, { action: 'remove', profileUrl });
}

// ---- Keys ---------------------------------------------------------

/**
 * The primary key of the whole database, so the extension and the sheet
 * have to derive it identically or one person ends up with two rows and
 * neither blocks the other. Mirrors normalizeUrl() in sheets/Code.gs and
 * normalizeProfileUrl() in content/content.js.
 */
export function normalizeKey(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (m) return 'https://www.linkedin.com/in/' + decodeURIComponent(m[1]).toLowerCase();
  const s = String(url || '').trim();
  return s ? s.toLowerCase() : '';
}

// ---- Merge rules --------------------------------------------------

/**
 * The one place that decides which version of a contact record wins.
 *
 * Earliest dateSent wins, because the question the extension answers is
 * "has anyone on this team already reached out?" — the first outreach is
 * the answer, and a later duplicate must never overwrite it. Ties go to
 * whichever record actually names a sender, so a sparse row loses to a
 * complete one.
 */
export function pickWinner(a, b) {
  if (!a) return b;
  if (!b) return a;

  const ta = Date.parse(a.dateSent || '');
  const tb = Date.parse(b.dateSent || '');
  if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta < tb ? a : b;
  if (!isNaN(ta) && isNaN(tb)) return a;
  if (isNaN(ta) && !isNaN(tb)) return b;

  const named = v => v && v.sentBy && v.sentBy !== 'Unknown';
  if (named(a) && !named(b)) return a;
  if (named(b) && !named(a)) return b;
  return a;
}

/** Folds remote rows into the local map without losing local-only work. */
export function mergeContacted(local, remote) {
  const merged = { ...(local || {}) };
  Object.keys(remote || {}).forEach(url => {
    merged[url] = normalizeEntry(pickWinner(merged[url], remote[url]));
  });
  return merged;
}

/** The shape the rest of the extension reads. */
export function normalizeEntry(entry) {
  const e = entry || {};
  return {
    name: e.name || 'Unknown',
    dateSent: e.dateSent || new Date().toISOString(),
    templateUsed: e.templateUsed || 'Unknown',
    sentBy: e.sentBy || 'Unknown',
    // Evidence that this row has been seen on the team sheet, and the reason
    // a delete can ever propagate: an entry the sheet has confirmed and later
    // stops reporting was removed by a teammate, so this install should drop
    // it too. An entry with no syncedAt has never made it to the sheet — it
    // is local history waiting to be uploaded, and absence proves nothing
    // about it.
    syncedAt: e.syncedAt || ''
  };
}

/** Stamps an entry as confirmed present on the sheet. */
export function markSynced(entry) {
  return { ...normalizeEntry(entry), syncedAt: new Date().toISOString() };
}
