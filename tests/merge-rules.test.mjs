// Exercises the pure decision logic: key normalization, first-writer-wins,
// and the local<->sheet merge. No Chrome APIs are touched.
import assert from 'node:assert';

const mod = await import(new URL('../background/sheets.js', import.meta.url).href);
const { normalizeKey, pickWinner, mergeContacted, normalizeEntry } = mod;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('normalizeKey');
t('strips query strings and trailing paths', () => {
  assert.equal(normalizeKey('https://www.linkedin.com/in/Jane-Doe-123/?utm=x'),
               'https://www.linkedin.com/in/jane-doe-123');
});
t('agrees across host and locale variants', () => {
  const a = normalizeKey('https://linkedin.com/in/Jane-Doe-123');
  const b = normalizeKey('https://www.linkedin.com/in/jane-doe-123/recent-activity/');
  const c = normalizeKey('http://uk.linkedin.com/in/JANE-DOE-123');
  assert.equal(a, b);
  assert.equal(b, c);
});
t('decodes percent-encoding so one person is one key', () => {
  assert.equal(normalizeKey('https://www.linkedin.com/in/jos%C3%A9-p'),
               'https://www.linkedin.com/in/josé-p');
});
t('empty input yields empty key', () => {
  assert.equal(normalizeKey(''), '');
  assert.equal(normalizeKey(null), '');
});

console.log('pickWinner — earliest outreach owns the profile');
const early = { name: 'Jane', dateSent: '2026-03-01T10:00:00.000Z', sentBy: 'Alice', templateUsed: 'A' };
const late  = { name: 'Jane', dateSent: '2026-03-05T10:00:00.000Z', sentBy: 'Bob',   templateUsed: 'B' };

t('earlier wins regardless of argument order', () => {
  assert.equal(pickWinner(early, late).sentBy, 'Alice');
  assert.equal(pickWinner(late, early).sentBy, 'Alice');
});
t('a missing side is not a winner', () => {
  assert.equal(pickWinner(null, late).sentBy, 'Bob');
  assert.equal(pickWinner(early, null).sentBy, 'Alice');
});
t('on a tie the record that names a sender wins', () => {
  const anon = { ...early, sentBy: 'Unknown' };
  const named = { ...early, sentBy: 'Alice' };
  assert.equal(pickWinner(anon, named).sentBy, 'Alice');
  assert.equal(pickWinner(named, anon).sentBy, 'Alice');
});
t('an unparseable date loses to a real one', () => {
  const broken = { ...late, dateSent: 'not a date' };
  assert.equal(pickWinner(broken, late).sentBy, 'Bob');
});

console.log('mergeContacted');
t('remote rows arrive without erasing local-only work', () => {
  const local  = { A: early, LOCAL_ONLY: { name: 'Zed', dateSent: '2026-04-01T00:00:00Z', sentBy: 'Me' } };
  const remote = { A: late,  REMOTE_ONLY: { name: 'Ray', dateSent: '2026-02-01T00:00:00Z', sentBy: 'Cass' } };
  const merged = mergeContacted(local, remote);

  assert.equal(Object.keys(merged).length, 3);
  assert.equal(merged.A.sentBy, 'Alice', 'a later remote row must not overwrite the first contact');
  assert.equal(merged.LOCAL_ONLY.sentBy, 'Me');
  assert.equal(merged.REMOTE_ONLY.sentBy, 'Cass');
});
t('merging is idempotent', () => {
  const local = { A: early };
  const once = mergeContacted(local, { A: late });
  const twice = mergeContacted(once, { A: late });
  assert.deepEqual(once, twice);
});
t('every merged row has the shape the UI reads', () => {
  const merged = mergeContacted({}, { A: { name: 'Ann' } });
  assert.deepEqual(Object.keys(merged.A).sort(),
                   ['dateSent', 'name', 'sentBy', 'syncedAt', 'templateUsed']);
  assert.equal(merged.A.sentBy, 'Unknown');
});
t('normalizeEntry fills gaps rather than dropping the row', () => {
  const e = normalizeEntry({ name: 'Ann' });
  assert.equal(e.name, 'Ann');
  assert.ok(Date.parse(e.dateSent));
});

console.log('\n' + pass + ' assertions passed');
