// Tests for src/resolve-run-figures.mjs. Every fixture value is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readWrittenFigure,
  resolveMarkerFiles,
  scanMarkers,
} from '../src/resolve-run-figures.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ea-run-figures-'));
  const run = join(root, 'evidence', 'study-a', 'run');
  mkdirSync(run, { recursive: true });
  mkdirSync(join(root, 'repo', 'docs'), { recursive: true });
  writeFileSync(
    join(run, 'agg.txt'),
    'trial 9 median 0.3127 upper 7.4186\n'
      + '[a] score: ratio 0.742 (bar <= 0.500)\n'
      + 'per batch upper 1.5 / upper 2.5\n'
      + 'labels: north  river,   south lake\n'
      + 'half 1.005\n'
      + 'near 1.0099\n'
      + 'delta -0.5\n'
      + 'count 1234567\n'
      + 'empty \n',
  );
  writeFileSync(join(run, 'r.json'), JSON.stringify({
    batches: [{ items: [{ latency_ms: 104.37 }, { latency_ms: 129.52 }] }],
    shift: -0.237,
    arr: [3],
    none: [],
    blank: '',
  }));
  writeFileSync(
    join(root, 'repo', 'docs', 'base.json'),
    JSON.stringify({ rows: [{ id: 'alpha', rate: 12.4, count: 31 }, { id: 'beta', rate: 6.2 }, { id: 'beta', rate: 8.9 }] }),
  );
  return { root, evidenceRoot: join(root, 'evidence'), repoRoot: join(root, 'repo') };
}

const AGG = 'study-a/run/agg.txt';
const RJSON = 'study-a/run/r.json';

function resolveProse(memo, fx) {
  const file = join(fx.root, 'memo.md');
  writeFileSync(file, memo);
  return resolveMarkerFiles({ files: [file], evidenceRoot: fx.evidenceRoot, repoRoot: fx.repoRoot });
}

test('a run-file JSON path, a tracked-JSON filter row and a text regex all resolve to MATCH', () => {
  const fx = fixture();
  const out = resolveProse(
    `the latency_ms is [r:${RJSON}#batches[0].items[0].latency_ms] 104,37 and the control [r:${RJSON}#batches[0].items[1].latency_ms] 129,52\n`
      + 'the rate is [r:docs/base.json#rows[id=alpha].rate] 12.4 % over [r:docs/base.json#rows[id=alpha].count] 31 trials\n'
      + `the score ratio is [r:${AGG}#/score: ratio ([0-9.]+)/] 0,742\n`,
    fx,
  );
  assert.deepEqual(
    out.rows.filter((r) => r.status !== 'MATCH').map((r) => r.message),
    [],
  );
  assert.equal(out.counts.match, 5);
  assert.equal(out.exitCode, 0);
});

test('a custom tracked-path pattern changes which root a marker path resolves against', () => {
  const fx = fixture();
  const memo = join(fx.root, 'memo.md');
  writeFileSync(memo, 'the rate is [r:docs/base.json#rows[id=alpha].rate] 12.4\n');
  const tracked = resolveMarkerFiles({ files: [memo], evidenceRoot: fx.evidenceRoot, repoRoot: fx.repoRoot });
  assert.deepEqual(tracked.rows.map((r) => r.status), ['MATCH']);
  // With a pattern that does not match `docs/`, the same path is looked up under the evidence root and is absent.
  const untracked = resolveMarkerFiles({ files: [memo], evidenceRoot: fx.evidenceRoot, repoRoot: fx.repoRoot, trackedPathRe: /^baselines\// });
  assert.deepEqual(untracked.rows.map((r) => r.status), ['UNRESOLVED']);
  assert.match(untracked.rows[0].message, /does not exist/);
});

test('the tolerance comes from the figure\'s own printed precision, and a comma is a decimal separator', () => {
  const fx = fixture();
  // 0.3127 written to three places is 0,313; 7.4186 written to three is 7,419.
  const out = resolveProse(
    `median [r:${AGG}#/median ([0-9.]+)/] 0,313 score, upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 7,419 score\n`,
    fx,
  );
  assert.deepEqual(out.rows.map((r) => r.status), ['MATCH', 'MATCH']);
  assert.equal(out.exitCode, 0);
});

test('a halfway value rounded either way matches — the tolerance is half a unit of the printed precision, not binary luck', () => {
  const fx = fixture();
  // 1.005 is stored as 1.00499…, so rounding it in binary gives 1.00 and a
  // correct half-up "1,01" would be flagged; both are honest two-place prints.
  const half = `[r:${AGG}#/half ([0-9.]+)/]`;
  const out = resolveProse(`${half} 1,01 or ${half} 1,00 but never ${half} 1,02\n`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['MATCH', 'MATCH', 'MISMATCH']);
  assert.equal(out.exitCode, 1);
});

test('a non-numeric fact is checked as a quoted string after whitespace normalisation', () => {
  const fx = fixture();
  const ok = resolveProse(`labels [r:${AGG}#/labels: (.+)$/m="north river, south lake"]\n`, fx);
  assert.deepEqual(ok.rows.map((r) => r.status), ['MATCH']);
  const bad = resolveProse(`labels [r:${AGG}#/labels: (.+)$/m="north river, east lake"]\n`, fx);
  assert.deepEqual(bad.rows.map((r) => r.status), ['MISMATCH']);
  assert.equal(bad.exitCode, 1);
});

test('a figure that disagrees with its run file is MISMATCH and exits 1, naming both values', () => {
  const fx = fixture();
  const out = resolveProse(`the latency_ms is [r:${RJSON}#batches[0].items[0].latency_ms] 129,52\n`, fx);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].status, 'MISMATCH');
  assert.match(out.rows[0].message, /found 104\.37/);
  assert.match(out.rows[0].message, /written 129,52/);
  assert.equal(out.counts.mismatch, 1);
  assert.equal(out.exitCode, 1);
});

test('every way a marker can point at nothing is UNRESOLVED and exits 2 — a silent skip is the class this check exists for', () => {
  const fx = fixture();
  const cases = [
    ['[r:study-a/run/absent.txt#/x ([0-9.]+)/] 1.0', /does not exist/],
    [`[r:${RJSON}#batches[0].items[9].latency_ms] 1.0`, /past the end/],
    [`[r:${RJSON}#batches[0].nope.latency_ms] 1.0`, /no key "nope"/],
    ['[r:docs/base.json#rows[id=missing].rate] 1.0', /no array element/],
    [`[r:${AGG}#/no such line ([0-9.]+)/] 1.0`, /matches nothing/],
    [`[r:${AGG}#/score: ratio [0-9.]+/] 0.742`, /exactly one capture group/],
    [`[r:${AGG}#/upper ([0-9.]+)/] 1.5`, /captures 3 different values/],
    [`[r:${AGG}#/median ([0-9.]+)/]`, /no figure/],
    ['[r:../escape.txt#/x ([0-9]+)/] 1', /may not contain/],
  ];
  for (const [memo, reason] of cases) {
    const out = resolveProse(`${memo}\n`, fx);
    assert.equal(out.rows.length, 1, memo);
    assert.equal(out.rows[0].status, 'UNRESOLVED', `${memo} -> ${out.rows[0].message}`);
    assert.match(out.rows[0].message, reason);
    assert.equal(out.exitCode, 2);
  }
});

test('a missing evidence root is named as such', () => {
  const fx = fixture();
  const file = join(fx.root, 'memo.md');
  writeFileSync(file, `[r:${RJSON}#shift] -0,237\n`);
  const out = resolveMarkerFiles({ files: [file], evidenceRoot: join(fx.root, 'no-such-root'), repoRoot: fx.repoRoot });
  assert.deepEqual(out.rows.map((r) => r.status), ['UNRESOLVED']);
  assert.match(out.rows[0].message, /the evidence root does not exist/);
  assert.equal(out.exitCode, 2);
});

test('a `[r:` the scanner cannot read is itself UNRESOLVED, never dropped', () => {
  const fx = fixture();
  const out = resolveProse('a truncated marker [r:some/file.txt#/pattern( and no close\n', fx);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].status, 'UNRESOLVED');
  assert.match(out.rows[0].message, /marker itself does not parse/);
  assert.equal(out.exitCode, 2);
});

test('HONEST LIMIT — an UNMARKED number is not checked at all', () => {
  const fx = fixture();
  // The same wrong figure as the MISMATCH arm above, written without a marker.
  const out = resolveProse('the latency_ms is 129,52 and nothing here can tell.\n', fx);
  assert.deepEqual(out.rows, []);
  assert.equal(out.counts.markers, 0);
  assert.equal(out.exitCode, 0);
  assert.match(out.summary, /0 markers/);
});

test('an ambiguous figure is read both ways and the matching reading is reported', () => {
  // `7,419` is both 7.419 and 7 419; the resolver never guesses silently.
  assert.deepEqual(readWrittenFigure('7,419').map((c) => c.value), [7.419, 7419]);
  assert.deepEqual(readWrittenFigure('0,313').map((c) => c.value), [0.313]);
  assert.deepEqual(readWrittenFigure('12.4').map((c) => c.value), [12.4]);
  assert.deepEqual(readWrittenFigure('1.234,56').map((c) => c.value), [1234.56]);
  assert.deepEqual(readWrittenFigure('-0,5').map((c) => c.value), [-0.5]);
  const fx = fixture();
  const out = resolveProse(`upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 7,419 score\n`, fx);
  assert.match(out.rows[0].message, /ambiguous/);
});

test('a documentation placeholder path is reported as EXAMPLE, printed rather than dropped', () => {
  const fx = fixture();
  // The placeholder is followed by prose, not by a figure (a figure after a
  // placeholder is the copy-paste case and is UNRESOLVED; see below).
  const out = resolveProse(`an example marker [r:<topic>/run/agg.txt#/median ([0-9.]+)/] and then the figure
`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['EXAMPLE']);
  assert.equal(out.counts.example, 1);
  assert.equal(out.exitCode, 0);
  // Prose about the syntax is EXAMPLE too, not UNRESOLVED.
  const prose = resolveProse('the marker is `[r:…]` and resolves against `[r:…#…]`', fx);
  assert.deepEqual(prose.rows.map((r) => r.status), ['EXAMPLE', 'EXAMPLE']);
  assert.equal(prose.exitCode, 0);
});

test('the scanner finds a marker inside an HTML comment, so a reader-facing memo stays clean', () => {
  const { markers, unreadable } = scanMarkers(`the median <!--[r:${AGG}#/median ([0-9.]+)/]-->0,313 is the figure\n`);
  assert.deepEqual(unreadable, []);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].written, '0,313');
  assert.equal(markers[0].line, 1);
});

// ---- Rival cases: each arm below is a way an earlier version failed open.

test('a REAL marker that lost its `]` inside <!-- --> is UNRESOLVED (exit 2), never EXAMPLE: placeholder is judged on the PATH, not the fragment', () => {
  const fx = fixture();
  // The comment's `-->` must not land in the placeholder test (the figure beside it is wrong: -0.237 written 0,237).
  // The second marker on the line is WELL-FORMED and still resolves (MATCH): the broken one must not eat it.
  const out = resolveProse(`measured <!--[r:${RJSON}#shift-->0,237 and n <!--[r:${RJSON}#arr[0]]-->3\n`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['UNRESOLVED', 'MATCH'], JSON.stringify(out.rows));
  assert.match(out.rows[0].message, /does not parse/);
  assert.equal(out.counts.example, 0);
  assert.equal(out.exitCode, 2);
  // A regex selector whose body holds `>` and a malformed tail is the same class.
  const rx = resolveProse(`x [r:${AGG}#/ratio >?([0-9.]+)/x 0,742\n`, fx);
  assert.deepEqual(rx.rows.map((r) => r.status), ['UNRESOLVED']);
  assert.equal(rx.exitCode, 2);
  // The vacuity arm: a genuine placeholder PATH (with no figure after it) is still EXAMPLE.
  const ex = resolveProse('an example [r:<topic>/run/agg.txt#/median ([0-9.]+)/] followed by prose and `[r:…]`\n', fx);
  assert.deepEqual(ex.rows.map((r) => r.status), ['EXAMPLE', 'EXAMPLE']);
  assert.equal(ex.exitCode, 0);
});

test('U+2212 and U+2013 before a digit are the figure\'s sign: a wrong sign is MISMATCH, a correct negative is MATCH', () => {
  const fx = fixture();
  const wrongSign = resolveProse(`delta [r:${AGG}#/delta (-?[0-9.]+)/] +0,5 and [r:${RJSON}#shift] −0,237 is the JSON\n`, fx);
  // agg has -0.5 (written +0,5 → MISMATCH); JSON has -0.237 (written −0,237 → MATCH)
  assert.deepEqual(wrongSign.rows.map((r) => r.status), ['MISMATCH', 'MATCH'], JSON.stringify(wrongSign.rows));
  const enDash = resolveProse(`delta [r:${AGG}#/delta (-?[0-9.]+)/] –0,5 but [r:${RJSON}#shift] –0,5 is not the JSON\n`, fx);
  assert.deepEqual(enDash.rows.map((r) => r.status), ['MATCH', 'MISMATCH']);
  assert.equal(enDash.exitCode, 1);
  const ascii = resolveProse(`delta [r:${AGG}#/delta (-?[0-9.]+)/] -0,5\n`, fx);
  assert.deepEqual(ascii.rows.map((r) => r.status), ['MATCH']);
});

test('the tolerance is HALF a printed unit and no more: 1,00 against 1.0099 is MISMATCH at two places, 1,01 is MATCH', () => {
  const fx = fixture();
  const near = `[r:${AGG}#/near ([0-9.]+)/]`;
  const out = resolveProse(`${near} 1,01 and ${near} 1,00\n`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['MATCH', 'MISMATCH'], JSON.stringify(out.rows));
  assert.equal(out.exitCode, 1);
});

test('a file holding both a MISMATCH and an UNRESOLVED exits 2: the check that did not happen outranks the one that failed', () => {
  const fx = fixture();
  const out = resolveProse(
    `wrong [r:${RJSON}#batches[0].items[0].latency_ms] 129,52 and absent [r:${RJSON}#batches[0].items[9].latency_ms] 1.0\n`,
    fx,
  );
  assert.deepEqual(out.rows.map((r) => r.status), ['MISMATCH', 'UNRESOLVED']);
  assert.equal(out.exitCode, 2);
});

test('a [key=value] filter that matches two rows is UNRESOLVED, never the first row', () => {
  const fx = fixture();
  const out = resolveProse('rate [r:docs/base.json#rows[id=beta].rate] 6.2\n', fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['UNRESOLVED']);
  assert.match(out.rows[0].message, /2 array elements have id=beta/);
  assert.equal(out.exitCode, 2);
});

test('an empty capture, an empty array, an empty string and a one-element array are NOT numbers: UNRESOLVED, never a coerced 0 or 3', () => {
  const fx = fixture();
  const cases = [
    [`[r:${AGG}#/empty (.*)$/m] 0`, /is not a number/],
    [`[r:${RJSON}#none] 0`, /is not a number/],
    [`[r:${RJSON}#blank] 0`, /is not a number/],
    [`[r:${RJSON}#arr] 3`, /is not a number/],
  ];
  for (const [memo, reason] of cases) {
    const out = resolveProse(`${memo}\n`, fx);
    assert.equal(out.rows[0].status, 'UNRESOLVED', `${memo} -> ${out.rows[0].message}`);
    assert.match(out.rows[0].message, reason);
    assert.equal(out.exitCode, 2);
  }
  // vacuity: the one-element array's ELEMENT, addressed, is a number.
  const ok = resolveProse(`[r:${RJSON}#arr[0]] 3\n`, fx);
  assert.deepEqual(ok.rows.map((r) => r.status), ['MATCH']);
});

test('a repeated single separator in groups of three is a grouped INTEGER: 1.234.567 and 1,234,567 both MATCH 1234567', () => {
  assert.deepEqual(readWrittenFigure('1.234.567').map((c) => c.value), [1234567]);
  assert.deepEqual(readWrittenFigure('1,234,567').map((c) => c.value), [1234567]);
  assert.deepEqual(readWrittenFigure('1.234,56').map((c) => c.value), [1234.56]);
  const fx = fixture();
  const out = resolveProse(`count [r:${AGG}#/count ([0-9]+)/] 1.234.567 and [r:${AGG}#/count ([0-9]+)/] 1,234,567\n`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['MATCH', 'MATCH'], JSON.stringify(out.rows));
});

test('a letter or `=` between the marker and the figure means NO figure follows, and a space-grouped figure is refused rather than read as its first group', () => {
  const fx = fixture();
  // `n=1 → 0,999` must not check the `1`.
  const window = resolveProse(`ratio [r:${AGG}#/score: ratio ([0-9.]+)/] n=1 → 0,999\n`, fx);
  assert.deepEqual(window.rows.map((r) => r.status), ['UNRESOLVED'], JSON.stringify(window.rows));
  assert.match(window.rows[0].message, /no figure follows/);
  // `7 419` must not be read as 7.
  const grouped = resolveProse(`upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 7 419 score\n`, fx);
  assert.deepEqual(grouped.rows.map((r) => r.status), ['UNRESOLVED'], JSON.stringify(grouped.rows));
  assert.match(grouped.rows[0].message, /not a figure this resolver can read/);
  // vacuity: punctuation between marker and figure is still fine.
  const ok = resolveProse(`ratio [r:${AGG}#/score: ratio ([0-9.]+)/] — **0,742**\n`, fx);
  assert.deepEqual(ok.rows.map((r) => r.status), ['MATCH']);
});

test('a near-miss prefix (`[R:`, `[r :`) is reported UNRESOLVED beside real markers and alone, never silently absent', () => {
  const fx = fixture();
  const beside = resolveProse(`good [r:${RJSON}#batches[0].items[0].latency_ms] 104,37 and bad [R:${RJSON}#batches[0].items[1].latency_ms] 129,52\n`, fx);
  // Rows on one line are reported unreadable-first; the pin is the SET, not the order.
  assert.deepEqual(beside.rows.map((r) => r.status).sort(), ['MATCH', 'UNRESOLVED'], JSON.stringify(beside.rows));
  assert.match(beside.rows.find((r) => r.status === 'UNRESOLVED').message, /near-miss/);
  assert.equal(beside.counts.match, 1);
  assert.equal(beside.exitCode, 2);
  const alone = resolveProse('only [r :some/file.txt#/x ([0-9]+)/] 1\n', fx);
  assert.deepEqual(alone.rows.map((r) => r.status), ['UNRESOLVED']);
  assert.equal(alone.exitCode, 2);
});

test('a malformed marker or a near-miss spelling QUOTED in backticks or a fenced block is EXAMPLE; the same text bare stays UNRESOLVED', () => {
  const fx = fixture();
  const quoted = resolveProse(
    'the writer typed `<!--[r:t/run/j.json#n-->0,237` and the prefix `[R:` or `[r :` — both are prose here\n'
      + '```\n[r:t/run/j.json#n-->0,237 broken inside a fence\n[R:whatever\n```\n',
    fx,
  );
  assert.deepEqual([...new Set(quoted.rows.map((r) => r.status))], ['EXAMPLE'], JSON.stringify(quoted.rows));
  assert.equal(quoted.exitCode, 0);
  // Vacuity: the SAME malformed marker outside code is still UNRESOLVED.
  const bare = resolveProse(`measured <!--[r:${RJSON}#shift-->0,237 and the prefix [R:x\n`, fx);
  assert.deepEqual(bare.rows.map((r) => r.status), ['UNRESOLVED', 'UNRESOLVED'], JSON.stringify(bare.rows));
  assert.equal(bare.exitCode, 2);
  // A real marker in backticks is EXAMPLE too: a live marker is never written in backticks.
  const realInCode = resolveProse(`the marker \`[r:${RJSON}#batches[0].items[0].latency_ms]\` 104,37\n`, fx);
  assert.deepEqual(realInCode.rows.map((r) => r.status), ['EXAMPLE']);
});

test('a near-miss hit INSIDE a real marker\'s own regex selector is not a row', () => {
  const fx = fixture();
  const out = resolveProse(`ratio [r:${AGG}#/score: ratio ([0-9.]+)|\\[R:x/] 0,742\n`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['MATCH'], JSON.stringify(out.rows));
});

test('a Unicode-space group (NBSP, narrow NBSP, thin space) is refused like an ASCII one; a decimal figure followed by an unrelated count is read as the figure', () => {
  const fx = fixture();
  for (const sp of ['\u00a0', '\u202f', '\u2009', ' ']) {
    const out = resolveProse(`upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 7${sp}419 score\n`, fx);
    assert.deepEqual(out.rows.map((r) => r.status), ['UNRESOLVED'], `U+${sp.codePointAt(0).toString(16)}: ${JSON.stringify(out.rows)}`);
  }
  const count = resolveProse(`ratio [r:${AGG}#/score: ratio ([0-9.]+)/] 0,742 102 trials\n`, fx);
  assert.deepEqual(count.rows.map((r) => r.status), ['MATCH'], JSON.stringify(count.rows));
});

test('an unfilled template path BESIDE a figure is UNRESOLVED, not EXAMPLE: the copy-paste case fails closed', () => {
  const fx = fixture();
  const out = resolveProse('median <!--[r:<topic>/run/agg.txt#/median ([0-9.]+)/]-->0,724 score\n', fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['UNRESOLVED'], JSON.stringify(out.rows));
  assert.match(out.rows[0].message, /placeholder path beside a figure/);
  assert.equal(out.exitCode, 2);
  // Vacuity: the same placeholder with NO figure after it is documentation → EXAMPLE.
  const prose = resolveProse('write it as [r:<topic>/run/agg.txt#/median ([0-9.]+)/] and the figure follows.\n', fx);
  assert.deepEqual(prose.rows.map((r) => r.status), ['EXAMPLE']);
});

test('an absolute marker path outside both roots is UNRESOLVED even when the file EXISTS (the confinement is pinned)', () => {
  const fx = fixture();
  // An existing JSON outside both roots: with the confinement removed this would MATCH.
  const outside = mkdtempSync(join(tmpdir(), 'ea-run-figures-outside-'));
  writeFileSync(join(outside, 'o.json'), JSON.stringify({ a: 1 }));
  const out = resolveProse(`x [r:${join(outside, 'o.json')}#a] 1\n`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['UNRESOLVED'], JSON.stringify(out.rows));
  assert.match(out.rows[0].message, /must lie under the evidence root or the repository/);
  assert.equal(out.exitCode, 2);
  // Vacuity: an absolute path INSIDE the evidence root resolves.
  const inside = resolveProse(`x [r:${join(fx.evidenceRoot, RJSON)}#batches[0].items[0].latency_ms] 104,37\n`, fx);
  assert.deepEqual(inside.rows.map((r) => r.status), ['MATCH'], JSON.stringify(inside.rows));
});

// ---- Code quoting follows CommonMark over the whole text: equal-length
// backtick runs, spans may cross line breaks inside a paragraph, a blank line
// ends the paragraph, an unmatched run quotes nothing; fences of backticks or
// tildes close on an equal-or-longer run, and an UNCLOSED fence is a finding.

const WRONG = () => `<!--[r:${AGG}#/score: ratio ([0-9.]+)/]-->0,724`; // the run file holds 0.742

test('a code span that closes on the NEXT line does not quote the rest of that line: a live wrong figure there is MISMATCH', () => {
  const fx = fixture();
  const wrapped = resolveProse(`* RED on a COPY: \`UNRESOLVED … index 9 is past the end\n  (4 elements)\`, EXIT 2; the score ratio is ${WRONG()}\n`, fx);
  assert.deepEqual(wrapped.rows.map((r) => r.status), ['MISMATCH'], JSON.stringify(wrapped.rows));
  assert.equal(wrapped.exitCode, 1);
  // control: the same text unwrapped
  const flat = resolveProse(`* RED on a COPY: \`UNRESOLVED … index 9 is past the end (4 elements)\`, EXIT 2; the score ratio is ${WRONG()}\n`, fx);
  assert.deepEqual(flat.rows.map((r) => r.status), ['MISMATCH']);
  // a quoted malformed example on the CONTINUATION line of a wrapped span is prose
  const cont = resolveProse('the old bug was `the writer typed\n<!--[r:t/run/j.json#n-->0,237` and it passed\n', fx);
  assert.deepEqual(cont.rows.map((r) => r.status), ['EXAMPLE'], JSON.stringify(cont.rows));
  assert.equal(cont.exitCode, 0);
});

test('a stray, unmatched backtick quotes NOTHING; a closed span before a live marker leaves it live', () => {
  const fx = fixture();
  const stray = resolveProse(`see the file\`s: ${WRONG()}\n`, fx);
  assert.deepEqual(stray.rows.map((r) => r.status), ['MISMATCH'], JSON.stringify(stray.rows));
  const strayPrev = resolveProse(`a stray \` here\nand the figure ${WRONG()}\n`, fx);
  assert.deepEqual(strayPrev.rows.map((r) => r.status), ['MISMATCH']);
  const closed = resolveProse(`see \`[R:x\` and then ${WRONG()}\n`, fx);
  assert.deepEqual(closed.rows.map((r) => r.status), ['EXAMPLE', 'MISMATCH'], JSON.stringify(closed.rows));
  // a live marker whose OWN regex selector holds a backtick, then a second live wrong figure
  const own = resolveProse(`x <!--[r:${AGG}#/ratio (\`?[0-9.]+)/]-->0,724 and ${WRONG()}\n`, fx);
  assert.deepEqual(own.rows.map((r) => r.status), ['MISMATCH', 'MISMATCH'], JSON.stringify(own.rows));
});

test('an UNCLOSED fence is an UNRESOLVED row and quotes nothing after its opener; a closed fence quotes only its body', () => {
  const fx = fixture();
  const open = resolveProse(`\`\`\`\nsome code\n\nprose again ${WRONG()}\n`, fx);
  assert.deepEqual(open.rows.map((r) => r.status).sort(), ['MISMATCH', 'UNRESOLVED'], JSON.stringify(open.rows));
  assert.match(open.rows.find((r) => r.status === 'UNRESOLVED').message, /unclosed code fence opened at line 1/);
  assert.equal(open.exitCode, 2);
  const indented = resolveProse(`  \`\`\`js\nsome code\n\nprose again ${WRONG()}\n`, fx);
  assert.deepEqual(indented.rows.map((r) => r.status).sort(), ['MISMATCH', 'UNRESOLVED']);
  const closed = resolveProse(`\`\`\`\n[r:t/run/j.json#n-->0,237 broken inside\n\`\`\`\nprose ${WRONG()}\n`, fx);
  assert.deepEqual(closed.rows.map((r) => r.status), ['EXAMPLE', 'MISMATCH'], JSON.stringify(closed.rows));
  // a four-backtick fence containing a ``` line closes only on a run of ≥ 4
  const nested = resolveProse(`\`\`\`\`\n\`\`\`\n[r:t/run/j.json#n-->0,237\n\`\`\`\`\nprose ${WRONG()}\n`, fx);
  assert.deepEqual(nested.rows.map((r) => r.status), ['EXAMPLE', 'MISMATCH'], JSON.stringify(nested.rows));
});

test('double-backtick spans and tilde fences are code too: a malformed example inside them is EXAMPLE', () => {
  const fx = fixture();
  const dbl = resolveProse('the writer typed ``<!--[r:t/run/j.json#n-->0,237`` once\n', fx);
  assert.deepEqual(dbl.rows.map((r) => r.status), ['EXAMPLE'], JSON.stringify(dbl.rows));
  const tilde = resolveProse('~~~\n[r:t/run/j.json#n-->0,237\n~~~\n', fx);
  assert.deepEqual(tilde.rows.map((r) => r.status), ['EXAMPLE'], JSON.stringify(tilde.rows));
  assert.equal(tilde.exitCode, 0);
});

test('an UNPARSED marker with a placeholder path beside a figure is UNRESOLVED, like the parsed one', () => {
  const fx = fixture();
  const out = resolveProse('ratio <!--[r:<topic>/t/run/j.json#n-->0,237 score\n', fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['UNRESOLVED'], JSON.stringify(out.rows));
  assert.equal(out.exitCode, 2);
  // vacuity: the same unparsed placeholder with no figure after it is documentation
  const prose = resolveProse('write it as [r:<topic>/t/run/j.json#n and then the figure\n', fx);
  assert.deepEqual(prose.rows.map((r) => r.status), ['EXAMPLE']);
});

test('a live marker in a table cell after a code cell is live', () => {
  const fx = fixture();
  const out = resolveProse(`| \`[r:…]\` | ${WRONG()} |\n`, fx);
  assert.deepEqual(out.rows.map((r) => r.status), ['EXAMPLE', 'MISMATCH'], JSON.stringify(out.rows));
});

test('an ambiguous MATCH is counted in the summary line', () => {
  const fx = fixture();
  const out = resolveProse(`upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 7,419 score and [r:${AGG}#/median ([0-9.]+)/] 0,313\n`, fx);
  assert.equal(out.counts.ambiguous, 1);
  assert.match(out.summary, /1 of the MATCHes ambiguous/);
});

// ---- The CLI entry, spawned as a user or a hook runs it.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVER_REL = path.join('src', 'resolve-run-figures.mjs');

function spawnResolver(cwd, args, script = RESOLVER_REL) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: { ...process.env, EA_EVIDENCE_ROOT: '' }, encoding: 'utf8' });
}

test('the CLI entry, spawned: no file argument exits 2 with the usage line; MATCH exits 0, MISMATCH 1, UNRESOLVED 2', () => {
  const noArg = spawnResolver(REPO_ROOT, []);
  assert.equal(noArg.status, 2, `stdout: ${noArg.stdout}\nstderr: ${noArg.stderr}`);
  assert.match(noArg.stderr, /usage: node src\/resolve-run-figures\.mjs/);
  const fx = fixture();
  const memo = join(fx.root, 'memo.md');
  const cases = [
    [`upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 7,419 score\n`, 0, /1 MATCH/],
    [`upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 9,999 score\n`, 1, /MISMATCH/],
    [`upper [r:${AGG}#/absent ([0-9.]+)/] 9,999 score\n`, 2, /UNRESOLVED/],
  ];
  for (const [text, code, out] of cases) {
    writeFileSync(memo, text);
    const run = spawnResolver(REPO_ROOT, ['--evidence-root', fx.evidenceRoot, memo]);
    assert.equal(run.status, code, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stdout, out);
  }
});

test('the CLI reads the evidence root from EA_EVIDENCE_ROOT when no flag is given', () => {
  const fx = fixture();
  const memo = join(fx.root, 'memo.md');
  writeFileSync(memo, `upper [r:${AGG}#/median [0-9.]+ upper ([0-9.]+)/] 9,999 score\n`);
  const run = spawnSync(process.execPath, [RESOLVER_REL, memo], { cwd: REPO_ROOT, env: { ...process.env, EA_EVIDENCE_ROOT: fx.evidenceRoot }, encoding: 'utf8' });
  assert.equal(run.status, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
});

test('the CLI refuses with exit 2 when the repository configuration is unreadable (fail closed, never the defaults)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea-resolver-config-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    writeFileSync(join(dir, 'evidence-admission.config.json'), '{ "evidenceRoot": ".evidence/", "typo": true }');
    writeFileSync(join(dir, 'memo.md'), 'no markers here\n');
    const run = spawnResolver(dir, ['memo.md'], path.join(REPO_ROOT, RESOLVER_REL));
    assert.equal(run.status, 2, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stderr, /unknown configuration key\(s\): typo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the documents that describe the marker syntax resolve with exit 0: every marker they quote is EXAMPLE', () => {
  const docs = ['README.md', path.join('examples', 'README.md'), 'PREREGISTRATION.md'].map((f) => join(REPO_ROOT, f));
  const out = resolveMarkerFiles({ files: docs, evidenceRoot: join(REPO_ROOT, 'examples'), repoRoot: REPO_ROOT });
  assert.deepEqual(out.rows.filter((r) => r.status === 'UNRESOLVED' || r.status === 'MISMATCH').map((r) => `${r.file}:${r.line}: ${r.marker} — ${r.message}`), []);
  assert.equal(out.exitCode, 0);
  assert.ok(out.counts.example > 0, 'the documents quote examples; the scan must have seen them');
});
