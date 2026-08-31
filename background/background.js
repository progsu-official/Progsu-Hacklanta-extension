// ============================================================
// Progsu LinkedIn Outreach Assistant — Background Service Worker
// ============================================================
// Manages storage for contacted profiles and message templates.
// Acts as the central hub that content scripts and the popup
// communicate with via chrome.runtime messaging.
//
// Contacted profiles live in two places at once:
//   * chrome.storage.local — the fast local cache every UI reads
//   * a shared Google Sheet — the team's source of truth, so an
//     outreach logged on one install blocks a duplicate on every
//     other one (see sheets/Code.gs)
// Local is a cache, never the authority: when the two disagree the
// earlier outreach wins, because "has anyone reached out yet?" is
// answered by the first contact, not the most recent write.
// ============================================================

import {
  getSheetConfig,
  saveSheetConfig,
  isConfigured,
  sheetPing,
  sheetList,
  sheetCheck,
  sheetMark,
  sheetBulk,
  sheetRemove,
  mergeContacted,
  normalizeEntry,
  normalizeKey,
  markSynced,
  pickWinner
} from './sheets.js';

// --- Default template used on first install ---
const DEFAULT_TEMPLATE = `Hi {{firstName}},

I came across your profile and was really impressed by your work at {{company}}. I'd love to connect and explore how we might collaborate.

Looking forward to hearing from you!`;

const SYNC_ALARM = 'progsu-sheet-sync';

// A profile the user is staring at gets checked on every scan pass. Without
// a short memory that is one Apps Script round trip per pass, which the
// quota notices long before the user does.
const REMOTE_CHECK_TTL_MS = 30000;
const remoteCheckCache = new Map(); // profileUrl -> { at, contacted, details }

// --- Install / Update handler ---
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      templates: [
        { id: generateId(), name: 'Default Outreach', body: DEFAULT_TEMPLATE, isDefault: true }
      ],
      contactedProfiles: {},   // { profileUrl: { name, dateSent, templateUsed, sentBy } }
      settings: {
        showBadge: true,        // Show "already contacted" badge on profiles
        showMarkers: true,      // Tag already-contacted people in search/list views
        autoPaste: true,        // Automatically paste when chat opens
        blockDuplicates: true,  // Refuse to message anyone the team already contacted
        teamName: 'Team Member' // Name of the person using this extension instance
      }
    });
  }

  // Settings written before blockDuplicates existed have no opinion on it,
  // and `undefined` would read as "off" at the guard. Default it to on.
  const { settings } = await chrome.storage.local.get('settings');
  if (settings && settings.blockDuplicates === undefined) {
    await chrome.storage.local.set({ settings: { ...settings, blockDuplicates: true } });
  }

  await rescheduleSync();
});

chrome.runtime.onStartup.addListener(async () => {
  await rescheduleSync();
  syncNow().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncNow().catch(() => {});
});

// --- Message router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    GET_TEMPLATES:        handleGetTemplates,
    SAVE_TEMPLATES:       handleSaveTemplates,
    GET_CONTACTED:        handleGetContacted,
    MARK_CONTACTED:       handleMarkContacted,
    REMOVE_CONTACTED:     handleRemoveContacted,
    CHECK_PROFILE:        handleCheckProfile,
    GET_SETTINGS:         handleGetSettings,
    SAVE_SETTINGS:        handleSaveSettings,
    EXPORT_CONTACTED:     handleExportContacted,
    IMPORT_CONTACTED:     handleImportContacted,
    CLEAR_ALL_CONTACTED:  handleClearAllContacted,
    GET_STATS:            handleGetStats,
    GET_SHEET_CONFIG:     handleGetSheetConfig,
    SAVE_SHEET_CONFIG:    handleSaveSheetConfig,
    TEST_SHEET:           handleTestSheet,
    SYNC_NOW:             handleSyncNow,
    GET_SYNC_STATE:       handleGetSyncState,
    PUSH_ALL_TO_SHEET:    handlePushAllToSheet
  };

  const handler = handlers[message.type];
  if (handler) {
    handler(message, sender)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: String(err && err.message || err) }));
    return true; // keeps the message channel open for async response
  }
});

// --- Handler implementations ---

async function handleGetTemplates() {
  const { templates } = await chrome.storage.local.get('templates');
  return { success: true, templates: templates || [] };
}

async function handleSaveTemplates(msg) {
  await chrome.storage.local.set({ templates: msg.templates });
  return { success: true };
}

async function handleGetContacted() {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  return { success: true, contactedProfiles: contactedProfiles || {} };
}

/**
 * Records an outreach locally, then pushes it to the team sheet.
 *
 * The local write happens first and unconditionally: a flaky network must
 * never cost the user their own outreach history. The sheet push then
 * either confirms it or reports that a teammate got there first, in which
 * case their record replaces ours — the first contact is the one that
 * matters, and now this install knows about it too.
 */
async function handleMarkContacted(msg) {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  const profileUrl = normalizeKey(msg.profileUrl);

  const entry = normalizeEntry({
    name: msg.name || 'Unknown',
    dateSent: new Date().toISOString(),
    templateUsed: msg.templateName || 'Unknown',
    sentBy: msg.sentBy || 'Unknown'
  });

  profiles[profileUrl] = pickWinner(profiles[profileUrl], entry);
  await chrome.storage.local.set({ contactedProfiles: profiles });
  remoteCheckCache.delete(profileUrl);

  const config = await getSheetConfig();
  if (!isConfigured(config)) return { success: true, synced: false };

  const res = await sheetMark(config, { profileUrl, ...profiles[profileUrl] });

  if (!res.ok) {
    // Queued rather than dropped — the next successful sync flushes it, so
    // an outreach logged on a bad connection still reaches the team.
    await enqueuePending(profileUrl, profiles[profileUrl]);
    await setSyncState({ lastError: res.error });
    return { success: true, synced: false, error: res.error };
  }

  if (res.duplicate && res.entry) {
    const winner = pickWinner(normalizeEntry(res.entry), profiles[profileUrl]);
    profiles[profileUrl] = markSynced(winner);
    await chrome.storage.local.set({ contactedProfiles: profiles });
    return { success: true, synced: true, duplicate: true, details: profiles[profileUrl] };
  }

  // The sheet took the row, so a later absence means a teammate removed it.
  profiles[profileUrl] = markSynced(profiles[profileUrl]);
  await chrome.storage.local.set({ contactedProfiles: profiles });

  await setSyncState({ lastError: '' });
  return { success: true, synced: true, duplicate: false };
}

async function handleRemoveContacted(msg) {
  const profileUrl = normalizeKey(msg.profileUrl);
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  // The raw key too: entries saved before keys were normalized are still
  // in some installs' storage, and a Remove that leaves one behind reads
  // to the user as a button that did nothing.
  delete profiles[profileUrl];
  delete profiles[msg.profileUrl];
  await chrome.storage.local.set({ contactedProfiles: profiles });
  remoteCheckCache.delete(profileUrl);

  const config = await getSheetConfig();
  if (!isConfigured(config)) return { success: true, synced: false };

  // Local-only removal would be undone by the next pull, so the row has to
  // go from the sheet too — removing here removes it for the whole team.
  const res = await sheetRemove(config, profileUrl);
  return { success: true, synced: !!res.ok, error: res.ok ? '' : res.error };
}

/**
 * The question the block guard asks. Answers from the sheet when it can,
 * because a teammate's outreach two minutes ago has not reached this
 * install's cache yet — that live lookup is what makes the block hold
 * across separate installs rather than only within one.
 */
async function handleCheckProfile(msg) {
  const profileUrl = normalizeKey(msg.profileUrl);
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  const local = profiles[profileUrl] || null;

  const config = await getSheetConfig();
  if (!isConfigured(config) || !profileUrl) {
    return { success: true, contacted: !!local, details: local, source: 'local' };
  }

  const cached = remoteCheckCache.get(profileUrl);
  if (cached && Date.now() - cached.at < REMOTE_CHECK_TTL_MS) {
    return { success: true, contacted: cached.contacted, details: cached.details, source: 'sheet-cache' };
  }

  const res = await sheetCheck(config, profileUrl);

  if (!res.ok) {
    // Falling back to the cache keeps the block working offline. It can only
    // be too permissive about outreach this install has never heard of, and
    // a stale "already contacted" is safer than a stale "go ahead".
    await setSyncState({ lastError: res.error });
    return { success: true, contacted: !!local, details: local, source: 'local', stale: true };
  }

  // The sheet answered, so it decides whether a row exists at all. Letting a
  // cached local copy outvote that "no" would make a removal unpropagatable:
  // the profile would stay blocked forever on every install that had ever
  // synced it.
  if (!res.contacted) {
    const cleared = await forgetIfConfirmedGone(profiles, profileUrl);
    remoteCheckCache.set(profileUrl, { at: Date.now(), contacted: !cleared && !!local, details: cleared ? null : local });
    return {
      success: true,
      contacted: !cleared && !!local,
      details: cleared ? null : local,
      source: 'sheet'
    };
  }

  const winner = markSynced(pickWinner(local, normalizeEntry(res.entry)));

  if (JSON.stringify(profiles[profileUrl]) !== JSON.stringify(winner)) {
    profiles[profileUrl] = winner;
    await chrome.storage.local.set({ contactedProfiles: profiles });
  }

  remoteCheckCache.set(profileUrl, { at: Date.now(), contacted: true, details: winner });
  return { success: true, contacted: true, details: winner, source: 'sheet' };
}

/**
 * Drops a local row the sheet no longer reports — but only one the sheet
 * previously confirmed and that isn't still queued for upload. Without both
 * guards this would delete outreach that simply hasn't been uploaded yet,
 * which is the opposite failure and a much worse one.
 *
 * Returns whether anything was dropped.
 */
async function forgetIfConfirmedGone(profiles, profileUrl) {
  const local = profiles[profileUrl];
  if (!local || !local.syncedAt) return false;

  const { pendingSync } = await chrome.storage.local.get('pendingSync');
  if (pendingSync && pendingSync[profileUrl]) return false;

  delete profiles[profileUrl];
  await chrome.storage.local.set({ contactedProfiles: profiles });
  return true;
}

async function handleGetSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { success: true, settings: settings || {} };
}

async function handleSaveSettings(msg) {
  await chrome.storage.local.set({ settings: msg.settings });
  return { success: true };
}

async function handleExportContacted() {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  return { success: true, data: JSON.stringify(contactedProfiles || {}, null, 2) };
}

async function handleImportContacted(msg) {
  try {
    const incoming = JSON.parse(msg.data);
    const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
    const merged = mergeContacted(contactedProfiles || {}, incoming);
    await chrome.storage.local.set({ contactedProfiles: merged });
    remoteCheckCache.clear();

    const config = await getSheetConfig();
    if (isConfigured(config)) await sheetBulk(config, incoming);

    return { success: true, count: Object.keys(incoming).length };
  } catch (e) {
    return { success: false, error: 'Invalid JSON data' };
  }
}

/**
 * Clears this install's cache only. The sheet is the team's record and one
 * person's "clear all" must not erase everyone else's history — the next
 * sync pulls the shared rows straight back.
 */
async function handleClearAllContacted() {
  await chrome.storage.local.set({ contactedProfiles: {} });
  remoteCheckCache.clear();
  const config = await getSheetConfig();
  return { success: true, sheetKept: isConfigured(config) };
}

async function handleGetStats() {
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  const total = Object.keys(profiles).length;
  const today = new Date().toISOString().split('T')[0];
  const todayCount = Object.values(profiles).filter(
    p => p.dateSent && p.dateSent.startsWith(today)
  ).length;
  return { success: true, total, todayCount };
}

// --- Sheet configuration & sync handlers ---

async function handleGetSheetConfig() {
  return { success: true, config: await getSheetConfig() };
}

async function handleSaveSheetConfig(msg) {
  const config = await saveSheetConfig(msg.config || {});
  remoteCheckCache.clear();
  await rescheduleSync();
  return { success: true, config };
}

async function handleTestSheet(msg) {
  // Tests what the form currently holds, not what was last saved, so the
  // user can verify a URL before committing to it.
  const config = msg.config
    ? { ...(await getSheetConfig()), ...msg.config, enabled: true }
    : await getSheetConfig();

  const res = await sheetPing(config);
  return res.ok
    ? { success: true, rows: res.rows, sheet: res.sheet }
    : { success: false, error: res.error };
}

async function handleSyncNow() {
  return syncNow();
}

async function handleGetSyncState() {
  const [{ syncState }, { pendingSync }, config] = await Promise.all([
    chrome.storage.local.get('syncState'),
    chrome.storage.local.get('pendingSync'),
    getSheetConfig()
  ]);
  return {
    success: true,
    state: syncState || {},
    pending: Object.keys(pendingSync || {}).length,
    configured: isConfigured(config)
  };
}

/** Seeds a fresh sheet from whatever this install already has locally. */
async function handlePushAllToSheet() {
  const config = await getSheetConfig();
  if (!isConfigured(config)) return { success: false, error: 'Team sheet is not set up yet' };

  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const entries = contactedProfiles || {};
  if (!Object.keys(entries).length) return { success: true, added: 0, skipped: 0 };

  const res = await sheetBulk(config, entries);
  return res.ok
    ? { success: true, added: res.added, skipped: res.skipped }
    : { success: false, error: res.error };
}

// --- Sync engine ---

/**
 * One round trip in each direction: flush anything that failed to push
 * earlier, then pull the team's rows down into the local cache.
 */
async function syncNow() {
  const config = await getSheetConfig();
  if (!isConfigured(config)) {
    return { success: false, error: 'Team sheet is not set up yet' };
  }

  const pushed = await flushPending(config);

  const res = await sheetList(config);
  if (!res.ok) {
    await setSyncState({ lastError: res.error });
    return { success: false, error: res.error, pushed };
  }

  const remote = {};
  Object.keys(res.entries || {}).forEach(url => {
    remote[url] = markSynced(res.entries[url]);
  });

  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const { pendingSync } = await chrome.storage.local.get('pendingSync');
  const merged = mergeContacted(contactedProfiles || {}, remote);

  // A full pull lists the whole sheet, so anything confirmed-but-missing was
  // removed by a teammate and has to go here too — otherwise a removal frees
  // the profile only on the install that performed it. Rows never confirmed
  // (local history from before the sheet was set up, or still queued) stay
  // put: their absence says nothing.
  let removed = 0;
  Object.keys(merged).forEach(url => {
    if (remote[url]) return;
    if (!merged[url].syncedAt) return;
    if (pendingSync && pendingSync[url]) return;
    delete merged[url];
    removed++;
  });

  await chrome.storage.local.set({ contactedProfiles: merged });
  remoteCheckCache.clear();

  await setSyncState({
    lastSyncAt: new Date().toISOString(),
    lastError: '',
    lastPulled: Object.keys(remote).length,
    lastPushed: pushed
  });

  return { success: true, pulled: Object.keys(remote).length, pushed, removed };
}

/** Retries the marks that could not reach the sheet when they happened. */
async function flushPending(config) {
  const { pendingSync } = await chrome.storage.local.get('pendingSync');
  const pending = pendingSync || {};
  const urls = Object.keys(pending);
  if (!urls.length) return 0;

  const res = await sheetBulk(config, pending);
  if (!res.ok) return 0;

  // Only clear on a confirmed write. Dropping the queue optimistically is
  // how outreach quietly goes missing from the team's record.
  await chrome.storage.local.set({ pendingSync: {} });

  // Now on the sheet, so a future absence is a real removal.
  const { contactedProfiles } = await chrome.storage.local.get('contactedProfiles');
  const profiles = contactedProfiles || {};
  urls.forEach(url => {
    if (profiles[url]) profiles[url] = markSynced(profiles[url]);
  });
  await chrome.storage.local.set({ contactedProfiles: profiles });

  return urls.length;
}

async function enqueuePending(profileUrl, entry) {
  const { pendingSync } = await chrome.storage.local.get('pendingSync');
  const pending = pendingSync || {};
  pending[profileUrl] = entry;
  await chrome.storage.local.set({ pendingSync: pending });
}

async function setSyncState(patch) {
  const { syncState } = await chrome.storage.local.get('syncState');
  await chrome.storage.local.set({ syncState: { ...(syncState || {}), ...patch } });
}

async function rescheduleSync() {
  const config = await getSheetConfig();
  await chrome.alarms.clear(SYNC_ALARM);
  if (!isConfigured(config)) return;
  chrome.alarms.create(SYNC_ALARM, {
    periodInMinutes: Math.max(1, Number(config.syncMinutes) || 5)
  });
}

// --- Utility ---
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
