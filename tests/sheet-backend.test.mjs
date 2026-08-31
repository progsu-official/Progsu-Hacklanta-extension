// Runs sheets/Code.gs against a fake SpreadsheetApp so the web-app contract
// (auth, first-writer-wins, list/check/remove/bulk) is verified before anyone
// pastes it into Apps Script.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

const src = fs.readFileSync(new URL('../sheets/Code.gs', import.meta.url), 'utf8');

// ---- Minimal fake Sheets ----
function makeSheet() {
  let rows = []; // rows[0] is the header once written

  const range = (r, c, nr, nc) => ({
    setValues(vals) {
      for (let i = 0; i < nr; i++) {
        const rowIdx = r - 1 + i;
        while (rows.length <= rowIdx) rows.push([]);
        for (let j = 0; j < nc; j++) rows[rowIdx][c - 1 + j] = vals[i][j];
      }
      return this;
    },
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) {
        const row = rows[r - 1 + i] || [];
        out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? ''));
      }
      return out;
    },
    setFontWeight() { return this; }
  });

  return {
    getLastRow: () => rows.length,
    getRange: range,
    appendRow(vals) { rows.push(vals.slice()); },
    deleteRow(n) { rows.splice(n - 1, 1); },
    setFrozenRows() {}, setColumnWidth() {},
    _dump: () => rows
  };
}

const sheets = {};
const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = makeSheet())
    })
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({ setMimeType: () => ({ _text: text }) })
  },
  console
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const TOKEN = sandbox.SHARED_TOKEN;
const post = body => JSON.parse(
  sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } })._text
);
const get = params => JSON.parse(sandbox.doGet({ parameter: params })._text);
const auth = body => post({ ...body, token: TOKEN });

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('auth');
t('a call with no token is refused', () => {
  const r = post({ action: 'list' });
  assert.equal(r.ok, false);
  assert.match(r.error, /token/i);
});
t('a call with the wrong token is refused', () => {
  assert.equal(post({ action: 'list', token: 'guess' }).ok, false);
});
t('a correct token is accepted, and ping reports an empty sheet', () => {
  const r = auth({ action: 'ping' });
  assert.equal(r.ok, true);
  assert.equal(r.rows, 0);
});

console.log('mark / check');
const JANE = 'https://www.linkedin.com/in/jane-doe-99';
t('a first mark is recorded', () => {
  const r = auth({ action: 'mark', profileUrl: JANE, name: 'Jane Doe',
                   sentBy: 'Alice', templateUsed: 'Cold v2',
                   dateSent: '2026-03-01T10:00:00.000Z' });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
});
t('check now reports her as contacted, naming the sender', () => {
  const r = auth({ action: 'check', profileUrl: JANE });
  assert.equal(r.contacted, true);
  assert.equal(r.entry.sentBy, 'Alice');
  assert.equal(r.entry.dateSent, '2026-03-01T10:00:00.000Z');
});
t('a URL variant resolves to the same person', () => {
  const r = auth({ action: 'check', profileUrl: 'https://LINKEDIN.com/in/Jane-Doe-99/?trk=x' });
  assert.equal(r.contacted, true, 'the key must survive case, host and query differences');
  assert.equal(r.entry.sentBy, 'Alice');
});
t('somebody else is not contacted', () => {
  assert.equal(auth({ action: 'check', profileUrl: 'https://www.linkedin.com/in/nobody' }).contacted, false);
});

console.log('first writer wins');
t("a teammate's later mark does not overwrite the row", () => {
  const r = auth({ action: 'mark', profileUrl: JANE + '/', name: 'Jane Doe',
                   sentBy: 'Bob', templateUsed: 'Warm v1',
                   dateSent: '2026-03-05T10:00:00.000Z' });
  assert.equal(r.duplicate, true, 'Bob must be told Alice got there first');
  assert.equal(r.entry.sentBy, 'Alice');
  assert.equal(r.entry.dateSent, '2026-03-01T10:00:00.000Z');
});
t('and no second row was appended', () => {
  assert.equal(auth({ action: 'ping' }).rows, 1);
});

console.log('bulk');
t('a backlog upload adds the new and skips the known', () => {
  const r = auth({ action: 'bulk', entries: {
    [JANE]: { name: 'Jane Doe', sentBy: 'Bob', dateSent: '2026-03-05T10:00:00.000Z' },
    'https://www.linkedin.com/in/Sam-R': { name: 'Sam R', sentBy: 'Cass', dateSent: '2026-02-01T00:00:00.000Z' },
    'https://www.linkedin.com/in/tam-q': { name: 'Tam Q', sentBy: 'Cass', dateSent: '2026-02-02T00:00:00.000Z' }
  }});
  assert.equal(r.ok, true);
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1, 'Jane was already on the sheet');
});
t('bulk normalized its keys too', () => {
  assert.equal(auth({ action: 'check', profileUrl: 'https://www.linkedin.com/in/sam-r' }).contacted, true);
});
t('duplicates inside one bulk payload collapse to one row', () => {
  const before = auth({ action: 'ping' }).rows;
  const r = auth({ action: 'bulk', entries: {
    'https://www.linkedin.com/in/dup-a': { name: 'Dup', sentBy: 'X' },
    'https://www.linkedin.com/in/DUP-A/': { name: 'Dup', sentBy: 'Y' }
  }});
  assert.equal(r.added, 1);
  assert.equal(auth({ action: 'ping' }).rows, before + 1);
});

console.log('list');
t('list returns every row keyed by profile URL', () => {
  const r = auth({ action: 'list' });
  assert.equal(r.ok, true);
  assert.equal(Object.keys(r.entries).length, 4);
  assert.equal(r.entries[JANE].sentBy, 'Alice');
});
t('list?since only returns rows touched after the cutoff', () => {
  const future = new Date(Date.now() + 60000).toISOString();
  assert.equal(Object.keys(auth({ action: 'list', since: future }).entries).length, 0);
  const past = new Date(Date.now() - 60000).toISOString();
  assert.ok(Object.keys(auth({ action: 'list', since: past }).entries).length > 0);
});

console.log('remove');
t('removing frees the profile for the whole team', () => {
  assert.equal(auth({ action: 'remove', profileUrl: JANE }).removed, true);
  assert.equal(auth({ action: 'check', profileUrl: JANE }).contacted, false);
});
t('removing an unknown profile is not an error', () => {
  const r = auth({ action: 'remove', profileUrl: 'https://www.linkedin.com/in/ghost' });
  assert.equal(r.ok, true);
  assert.equal(r.removed, false);
});
t('the row that was deleted is really gone, and the rest survived', () => {
  assert.equal(auth({ action: 'ping' }).rows, 3);
  assert.equal(auth({ action: 'check', profileUrl: 'https://www.linkedin.com/in/tam-q' }).contacted, true);
});

console.log('misc');
t('GET works too, for a browser sanity check', () => {
  assert.equal(get({ action: 'ping', token: TOKEN }).ok, true);
});
t('a mark with no profileUrl is rejected rather than written', () => {
  assert.equal(auth({ action: 'mark', name: 'Nobody' }).ok, false);
});
t('an unknown action is reported, not silently ignored', () => {
  assert.match(auth({ action: 'nonsense' }).error, /Unknown action/);
});
t('malformed JSON does not take the endpoint down', () => {
  const r = JSON.parse(sandbox.doPost({ parameter: {}, postData: { contents: '{oops' } })._text);
  assert.equal(r.ok, false);
});
t('the header row is intact and correctly ordered', () => {
  assert.deepEqual(sheets.Outreach._dump()[0], sandbox.HEADERS);
});

console.log('\n' + pass + ' assertions passed');
console.log('\nfinal sheet:');
for (const row of sheets.Outreach._dump()) console.log('  ' + row.slice(0, 4).join(' | '));
