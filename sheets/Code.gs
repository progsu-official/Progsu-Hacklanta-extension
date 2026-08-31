/**
 * ============================================================
 * Progsu Outreach — Google Sheet backend (Apps Script Web App)
 * ============================================================
 * Turns one Google Sheet into the shared "already contacted" database
 * for every install of the Progsu extension.
 *
 * SETUP (once, by whoever owns the sheet):
 *   1. Create a Google Sheet. Extensions > Apps Script.
 *   2. Delete the placeholder code, paste this file in, Save.
 *   3. Set SHARED_TOKEN below to any random string. Every teammate
 *      types this same string into the extension.
 *   4. Deploy > New deployment > type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      ("Anyone" is required — the extension calls this without a Google
 *       login. SHARED_TOKEN is what actually gates access, so treat it
 *       like a password.)
 *   5. Copy the /exec URL it gives you. That plus the token is what each
 *      teammate pastes into the extension's Team Sync settings.
 *
 * The sheet's own tab is created and headed automatically on first write.
 * ============================================================
 */

var SHARED_TOKEN = 'CHANGE-ME-to-a-random-string';
var SHEET_NAME   = 'Outreach';

var HEADERS = [
  'Profile URL',      // normalized, the primary key
  'Name',
  'Date Contacted',   // ISO 8601, first contact — never overwritten
  'Contacted By',
  'Template Used',
  'Last Updated'      // ISO 8601, bookkeeping for incremental pulls
];

// ---- Entry points -------------------------------------------------

function doGet(e) {
  return handle((e && e.parameter) || {}, null);
}

function doPost(e) {
  var params = (e && e.parameter) || {};
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Body was not valid JSON' });
  }
  return handle(params, body);
}

function handle(params, body) {
  var req = body || {};
  var action = req.action || params.action || 'ping';
  var token = req.token || params.token || '';

  if (SHARED_TOKEN && token !== SHARED_TOKEN) {
    return json({ ok: false, error: 'Bad or missing token' });
  }

  try {
    switch (action) {
      case 'ping':   return json({ ok: true, action: 'ping', sheet: SHEET_NAME, rows: countRows() });
      case 'list':   return json({ ok: true, action: 'list', entries: listEntries(req.since || params.since) });
      case 'check':  return doCheck(req.profileUrl || params.profileUrl);
      case 'mark':   return doMark(req);
      case 'bulk':   return doBulk(req.entries);
      case 'remove': return doRemove(req.profileUrl || params.profileUrl);
      default:       return json({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---- Actions ------------------------------------------------------

function doCheck(profileUrl) {
  var key = normalizeUrl(profileUrl);
  if (!key) return json({ ok: false, error: 'profileUrl is required' });

  var found = findRow(readAll(), key);
  return json({
    ok: true,
    action: 'check',
    contacted: !!found,
    entry: found ? found.entry : null
  });
}

/**
 * Records one profile as contacted.
 *
 * First writer wins: if someone on the team already logged this profile,
 * the existing row is left exactly as it was and returned to the caller.
 * That is the whole point of the shared sheet — whoever reached out first
 * keeps the credit, and every other install learns to stay away.
 */
function doMark(req) {
  var key = normalizeUrl(req.profileUrl);
  if (!key) return json({ ok: false, error: 'profileUrl is required' });

  var lock = LockService.getScriptLock();
  // Two teammates opening the same profile at the same moment would
  // otherwise both read "not contacted" and both append a row.
  lock.waitLock(20000);
  try {
    var sheet = getSheet();
    var found = findRow(readAll(), key);

    if (found) {
      return json({ ok: true, action: 'mark', duplicate: true, entry: found.entry });
    }

    var now = new Date().toISOString();
    var entry = {
      profileUrl:   key,
      name:         String(req.name || 'Unknown'),
      dateSent:     req.dateSent || now,
      sentBy:       String(req.sentBy || 'Unknown'),
      templateUsed: String(req.templateUsed || ''),
      updatedAt:    now
    };
    sheet.appendRow(toRow(entry));
    return json({ ok: true, action: 'mark', duplicate: false, entry: entry });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Pushes many entries at once — used when an install comes back online
 * with a backlog, or when someone seeds the sheet from an old JSON export.
 * Same first-writer-wins rule, applied per row.
 */
function doBulk(entries) {
  if (!entries || typeof entries !== 'object') {
    return json({ ok: false, error: 'entries object is required' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var rows = readAll();
    var seen = {};
    for (var i = 0; i < rows.length; i++) seen[rows[i].entry.profileUrl] = true;

    var now = new Date().toISOString();
    var toAppend = [];
    var added = 0, skipped = 0;

    Object.keys(entries).forEach(function (rawUrl) {
      var key = normalizeUrl(rawUrl);
      if (!key || seen[key]) { skipped++; return; }
      seen[key] = true;

      var v = entries[rawUrl] || {};
      toAppend.push(toRow({
        profileUrl:   key,
        name:         String(v.name || 'Unknown'),
        dateSent:     v.dateSent || now,
        sentBy:       String(v.sentBy || 'Unknown'),
        templateUsed: String(v.templateUsed || ''),
        updatedAt:    now
      }));
      added++;
    });

    if (toAppend.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, HEADERS.length)
           .setValues(toAppend);
    }
    return json({ ok: true, action: 'bulk', added: added, skipped: skipped });
  } finally {
    lock.releaseLock();
  }
}

function doRemove(profileUrl) {
  var key = normalizeUrl(profileUrl);
  if (!key) return json({ ok: false, error: 'profileUrl is required' });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findRow(readAll(), key);
    if (!found) return json({ ok: true, action: 'remove', removed: false });
    getSheet().deleteRow(found.rowNumber);
    return json({ ok: true, action: 'remove', removed: true });
  } finally {
    lock.releaseLock();
  }
}

// ---- Sheet access -------------------------------------------------

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 320);
    sheet.setColumnWidth(2, 180);
  }
  return sheet;
}

/** Every data row as { entry, rowNumber }, header excluded. */
function readAll() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var key = normalizeUrl(r[0]);
    if (!key) continue;
    out.push({
      rowNumber: i + 2,
      entry: {
        profileUrl:   key,
        name:         String(r[1] || ''),
        dateSent:     asIso(r[2]),
        sentBy:       String(r[3] || ''),
        templateUsed: String(r[4] || ''),
        updatedAt:    asIso(r[5])
      }
    });
  }
  return out;
}

function findRow(rows, key) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].entry.profileUrl === key) return rows[i];
  }
  return null;
}

/** Keyed by profile URL, which is the shape the extension stores locally. */
function listEntries(since) {
  var cutoff = since ? Date.parse(since) : NaN;
  var rows = readAll();
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var e = rows[i].entry;
    if (!isNaN(cutoff)) {
      var stamp = Date.parse(e.updatedAt || e.dateSent);
      if (!isNaN(stamp) && stamp <= cutoff) continue;
    }
    map[e.profileUrl] = e;
  }
  return map;
}

function countRows() {
  return Math.max(0, getSheet().getLastRow() - 1);
}

function toRow(e) {
  return [e.profileUrl, e.name, e.dateSent, e.sentBy, e.templateUsed, e.updatedAt];
}

// ---- Helpers ------------------------------------------------------

/**
 * The extension and the sheet must agree on the key, or the same person
 * gets two rows. Mirrors normalizeProfileUrl() in content/content.js.
 */
function normalizeUrl(url) {
  var m = String(url || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
  if (m) return 'https://www.linkedin.com/in/' + decodeURIComponent(m[1]).toLowerCase();
  var s = String(url || '').trim();
  return s ? s.toLowerCase() : '';
}

/** Sheets hands back a Date for anything that looks like one; JSON needs ISO. */
function asIso(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
