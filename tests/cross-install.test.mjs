// Two independent installs of the extension, one shared sheet.
// Runs the REAL background/background.js against a fake chrome API and a
// fetch wired to the real sheets/Code.gs, to prove the thing the feature
// claims: outreach logged by Alice blocks Bob on a different machine.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

const ROOT = new URL('../', import.meta.url).href;

// ---------- The shared Google Sheet (real Code.gs, fake Sheets) ----------
function makeSheet() {
  let rows = [];
  return {
    getLastRow: () => rows.length,
    getRange: (r, c, nr, nc) => ({
      setValues(v) {
        for (let i = 0; i < nr; i++) {
          const ri = r - 1 + i;
          while (rows.length <= ri) rows.push([]);
          for (let j = 0; j < nc; j++) rows[ri][c - 1 + j] = v[i][j];
        }
        return this;
      },
      getValues: () => Array.from({ length: nr }, (_, i) => {
        const row = rows[r - 1 + i] || [];
        return Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '');
      }),
      setFontWeight() { return this; }
    }),
    appendRow: v => rows.push(v.slice()),
    deleteRow: n => rows.splice(n - 1, 1),
    setFrozenRows() {}, setColumnWidth() {},
    _rows: () => rows
  };
}

const sheetTabs = {};
const gas = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({
    getSheetByName: n => sheetTabs[n] || null,
    insertSheet: n => (sheetTabs[n] = makeSheet())
  })},
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: t => ({ setMimeType: () => ({ _text: t }) })
  },
  console
};
vm.createContext(gas);
vm.runInContext(fs.readFileSync(new URL('../sheets/Code.gs', import.meta.url), 'utf8'), gas);

const SHEET_URL = 'https://script.google.com/macros/s/FAKE/exec';
const SHEET_TOKEN = gas.SHARED_TOKEN;

// Network switch, so an offline install can be simulated.
let online = true;
let requestCount = 0;

globalThis.fetch = async (url, opts) => {
  requestCount++;
  if (!online) throw new Error('net::ERR_INTERNET_DISCONNECTED');
  assert.equal(url, SHEET_URL);
  assert.equal(opts.headers['Content-Type'], 'text/plain;charset=utf-8',
               'must stay a CORS-safelisted content type or Apps Script never sees the request');
  const out = gas.doPost({ parameter: {}, postData: { contents: opts.body } });
  return { ok: true, status: 200, text: async () => out._text };
};

// ---------- A fake Chrome, one per install ----------
let active = null;
globalThis.chrome = new Proxy({}, { get: (_, k) => active.api[k] });

function makeInstall(name) {
  const store = {};
  const listeners = { message: [], installed: [], startup: [], alarm: [] };

  const api = {
    storage: {
      local: {
        async get(keys) {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        async set(obj) { for (const k of Object.keys(obj)) store[k] = structuredClone(obj[k]); }
      }
    },
    runtime: {
      onMessage:   { addListener: f => listeners.message.push(f) },
      onInstalled: { addListener: f => listeners.installed.push(f) },
      onStartup:   { addListener: f => listeners.startup.push(f) }
    },
    alarms: {
      onAlarm: { addListener: f => listeners.alarm.push(f) },
      async create() {}, async clear() { return true; }
    }
  };

  return { name, api, listeners, store };
}

async function send(install, msg) {
  active = install;
  for (const fn of install.listeners.message) {
    let resolve;
    const p = new Promise(r => (resolve = r));
    if (fn(msg, {}, resolve) === true) return p;
  }
  throw new Error('no handler for ' + msg.type);
}

async function boot(install, tag) {
  active = install;
  // Fresh module instance per install — the query string defeats the ESM cache.
  await import(ROOT + 'background/background.js' + '?i=' + tag);
  for (const fn of install.listeners.installed) await fn({ reason: 'install' });
  await send(install, { type: 'SAVE_SHEET_CONFIG',
                        config: { url: SHEET_URL, token: SHEET_TOKEN, enabled: true } });
}

// ---------- The scenario ----------
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

const alice = makeInstall('Alice');
const bob = makeInstall('Bob');
await boot(alice, 'alice');
await boot(bob, 'bob');

const JANE = 'https://www.linkedin.com/in/jane-doe-99';

console.log('setup');
await t('both installs start with an empty contacted list', async () => {
  for (const who of [alice, bob]) {
    const r = await send(who, { type: 'GET_CONTACTED' });
    assert.deepEqual(r.contactedProfiles, {});
  }
});
await t('blocking is on by default', async () => {
  const r = await send(bob, { type: 'GET_SETTINGS' });
  assert.equal(r.settings.blockDuplicates, true);
});

console.log('\nAlice reaches out');
await t('her mark is recorded locally and pushed to the sheet', async () => {
  const r = await send(alice, { type: 'MARK_CONTACTED', profileUrl: JANE + '/?trk=nav',
                                name: 'Jane Doe', templateName: 'Cold v2', sentBy: 'Alice' });
  assert.equal(r.success, true);
  assert.equal(r.synced, true);
  assert.equal(r.duplicate, false);
});

console.log('\nBob — a different machine that has never synced');
await t('THE CLAIM: Bob is told Jane is already contacted', async () => {
  const r = await send(bob, { type: 'CHECK_PROFILE', profileUrl: JANE });
  assert.equal(r.contacted, true, 'Bob must be blocked by Alice\'s outreach');
  assert.equal(r.details.sentBy, 'Alice');
  assert.equal(r.source, 'sheet', 'the verdict has to come from the sheet, not a stale local cache');
});
await t('a URL variant on Bob\'s screen resolves to the same person', async () => {
  const r = await send(bob, { type: 'CHECK_PROFILE',
                              profileUrl: 'https://www.linkedin.com/in/Jane-Doe-99/' });
  assert.equal(r.contacted, true);
});
await t('the lookup is cached, so staring at a profile is not a request storm', async () => {
  const before = requestCount;
  for (let i = 0; i < 20; i++) await send(bob, { type: 'CHECK_PROFILE', profileUrl: JANE });
  assert.equal(requestCount, before, 'repeat checks must be served from the 30s cache');
});
await t('and Bob\'s local cache learned about her, so markers show up too', async () => {
  const r = await send(bob, { type: 'GET_CONTACTED' });
  assert.equal(r.contactedProfiles[JANE].sentBy, 'Alice');
});
await t('if Bob marks her anyway, Alice keeps the credit', async () => {
  const r = await send(bob, { type: 'MARK_CONTACTED', profileUrl: JANE,
                              name: 'Jane Doe', templateName: 'Warm v1', sentBy: 'Bob' });
  assert.equal(r.duplicate, true);
  assert.equal(r.details.sentBy, 'Alice');
  assert.equal(gas.countRows(), 1, 'no second row for the same person');
});
await t('someone nobody has touched is not blocked', async () => {
  const r = await send(bob, { type: 'CHECK_PROFILE',
                              profileUrl: 'https://www.linkedin.com/in/fresh-lead' });
  assert.equal(r.contacted, false);
});

console.log('\noffline behaviour');
await t('a mark taken offline is kept, not lost', async () => {
  online = false;
  const r = await send(alice, { type: 'MARK_CONTACTED',
                                profileUrl: 'https://www.linkedin.com/in/sam-r',
                                name: 'Sam R', templateName: 'Cold v2', sentBy: 'Alice' });
  assert.equal(r.success, true, 'the user\'s own history must survive a network failure');
  assert.equal(r.synced, false);
  const state = await send(alice, { type: 'GET_SYNC_STATE' });
  assert.equal(state.pending, 1, 'it should be queued for the next sync');
});
await t('offline, the local cache still answers the block question', async () => {
  const r = await send(alice, { type: 'CHECK_PROFILE', profileUrl: JANE });
  assert.equal(r.contacted, true);
  assert.equal(r.stale, true, 'and it should admit the answer may be stale');
});
await t('back online, the backlog flushes and the queue empties', async () => {
  online = true;
  const r = await send(alice, { type: 'SYNC_NOW' });
  assert.equal(r.success, true);
  assert.equal(r.pushed, 1);
  const state = await send(alice, { type: 'GET_SYNC_STATE' });
  assert.equal(state.pending, 0);
});
await t('so Bob is now blocked on Sam too', async () => {
  const r = await send(bob, { type: 'CHECK_PROFILE', profileUrl: 'https://www.linkedin.com/in/sam-r' });
  assert.equal(r.contacted, true);
  assert.equal(r.details.sentBy, 'Alice');
});

console.log('\nclear and restore');
await t('Clear All wipes Bob locally but leaves the team sheet alone', async () => {
  const r = await send(bob, { type: 'CLEAR_ALL_CONTACTED' });
  assert.equal(r.sheetKept, true);
  const got = await send(bob, { type: 'GET_CONTACTED' });
  assert.deepEqual(got.contactedProfiles, {});
  assert.equal(gas.countRows(), 2, 'one person clearing must not erase the team\'s record');
});
await t('a sync brings the whole team list straight back', async () => {
  const r = await send(bob, { type: 'SYNC_NOW' });
  assert.equal(r.pulled, 2);
  const got = await send(bob, { type: 'GET_CONTACTED' });
  assert.equal(Object.keys(got.contactedProfiles).length, 2);
  assert.equal(got.contactedProfiles[JANE].sentBy, 'Alice');
});

console.log('\nremoval');
await t('removing Jane on Alice frees her for the whole team', async () => {
  const r = await send(alice, { type: 'REMOVE_CONTACTED', profileUrl: JANE });
  assert.equal(r.synced, true);
  const check = await send(bob, { type: 'CHECK_PROFILE', profileUrl: JANE });
  assert.equal(check.contacted, false, 'Bob should be free to message her now');
});

console.log('\nseeding a fresh sheet');
await t('Upload My List pushes local history up and skips what is known', async () => {
  await send(bob, { type: 'MARK_CONTACTED', profileUrl: 'https://www.linkedin.com/in/local-only',
                    name: 'Local Only', sentBy: 'Bob' });
  const r = await send(bob, { type: 'PUSH_ALL_TO_SHEET' });
  assert.equal(r.success, true);
  assert.equal(r.skipped >= 1, true, 'rows already on the sheet are skipped, not duplicated');
});

console.log('\nmisconfiguration');
await t('sync is refused, with a reason, when no sheet is set up', async () => {
  const solo = makeInstall('Solo');
  await boot(solo, 'solo');
  await send(solo, { type: 'SAVE_SHEET_CONFIG', config: { url: '', token: '', enabled: true } });
  const cfg = await send(solo, { type: 'GET_SHEET_CONFIG' });
  assert.equal(cfg.config.enabled, false, 'enabling without a URL must not stick');
  const r = await send(solo, { type: 'SYNC_NOW' });
  assert.equal(r.success, false);
  assert.match(r.error, /not set up/i);
});
await t('a solo install still tracks and answers locally', async () => {
  const solo = makeInstall('Solo2');
  await boot(solo, 'solo2');
  await send(solo, { type: 'SAVE_SHEET_CONFIG', config: { url: '', token: '', enabled: false } });
  await send(solo, { type: 'MARK_CONTACTED', profileUrl: JANE, name: 'Jane', sentBy: 'Solo' });
  const r = await send(solo, { type: 'CHECK_PROFILE', profileUrl: JANE });
  assert.equal(r.contacted, true);
  assert.equal(r.source, 'local');
});
await t('a bad token is reported rather than silently ignored', async () => {
  const r = await send(bob, { type: 'TEST_SHEET', config: { url: SHEET_URL, token: 'wrong' } });
  assert.equal(r.success, false);
  assert.match(r.error, /token/i);
});
await t('a Google login page is diagnosed as a deployment problem', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>Sign in</html>' });
  const r = await send(bob, { type: 'TEST_SHEET', config: { url: SHEET_URL, token: SHEET_TOKEN } });
  assert.equal(r.success, false);
  assert.match(r.error, /Anyone/, 'the message should name the actual fix');
  globalThis.fetch = saved;
});

console.log('\ndeletion vs. un-uploaded history');
await t('a full sync propagates a teammate removal, not just a live check', async () => {
  const carl = makeInstall('Carl');
  await boot(carl, 'carl');
  await send(carl, { type: 'MARK_CONTACTED', profileUrl: 'https://www.linkedin.com/in/gone-soon',
                     name: 'Gone Soon', sentBy: 'Carl' });
  await send(bob, { type: 'SYNC_NOW' });
  let got = await send(bob, { type: 'GET_CONTACTED' });
  assert.ok(got.contactedProfiles['https://www.linkedin.com/in/gone-soon'], 'Bob should have pulled it');

  await send(carl, { type: 'REMOVE_CONTACTED', profileUrl: 'https://www.linkedin.com/in/gone-soon' });
  const r = await send(bob, { type: 'SYNC_NOW' });
  assert.equal(r.removed, 1, 'the sync should drop the row the sheet no longer has');
  got = await send(bob, { type: 'GET_CONTACTED' });
  assert.equal(got.contactedProfiles['https://www.linkedin.com/in/gone-soon'], undefined);
});

await t('history from before the sheet was set up survives a sync', async () => {
  const dana = makeInstall('Dana');
  active = dana;
  await import(ROOT + 'background/background.js' + '?i=dana');
  for (const fn of dana.listeners.installed) await fn({ reason: 'install' });

  // Marked while running solo — this never reached any sheet.
  await send(dana, { type: 'MARK_CONTACTED', profileUrl: 'https://www.linkedin.com/in/old-lead',
                     name: 'Old Lead', sentBy: 'Dana' });

  // Now she joins the team.
  await send(dana, { type: 'SAVE_SHEET_CONFIG',
                     config: { url: SHEET_URL, token: SHEET_TOKEN, enabled: true } });
  const r = await send(dana, { type: 'SYNC_NOW' });
  assert.equal(r.removed, 0, 'nothing was confirmed on the sheet, so nothing may be dropped');

  const got = await send(dana, { type: 'GET_CONTACTED' });
  assert.ok(got.contactedProfiles['https://www.linkedin.com/in/old-lead'],
            'a full pull must not mistake never-uploaded history for a deletion');

  // And Upload My List is how it reaches the team.
  await send(dana, { type: 'PUSH_ALL_TO_SHEET' });
  const check = await send(bob, { type: 'CHECK_PROFILE',
                                  profileUrl: 'https://www.linkedin.com/in/old-lead' });
  assert.equal(check.contacted, true);
});

await t('a queued offline mark is not deleted by the sync that uploads it', async () => {
  const erin = makeInstall('Erin');
  await boot(erin, 'erin');
  await send(erin, { type: 'SYNC_NOW' });

  online = false;
  await send(erin, { type: 'MARK_CONTACTED', profileUrl: 'https://www.linkedin.com/in/queued-lead',
                     name: 'Queued Lead', sentBy: 'Erin' });
  online = true;

  const r = await send(erin, { type: 'SYNC_NOW' });
  assert.equal(r.pushed, 1);
  const after = await send(erin, { type: 'GET_CONTACTED' });
  assert.ok(after.contactedProfiles['https://www.linkedin.com/in/queued-lead'],
            'the queued row must survive the same sync that uploads it');
});

console.log('\n' + pass + ' assertions passed');
console.log('\nfinal shared sheet:');
for (const row of sheetTabs.Outreach._rows()) console.log('  ' + row.slice(0, 4).join(' | '));
