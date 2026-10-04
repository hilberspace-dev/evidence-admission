// A narrated, self-checking demo of the three checks, on the synthetic
// examples in ./examples. Run it from the repository root:
//
//   npm run demo
//
// It runs seven commands, prints each one with its output and exit code, and
// says in one line what that exit code means for a research report. Every
// value it shows is synthetic. At the end it compares the exit codes it
// OBSERVED with the ones this file EXPECTS and exits 0 only when all seven
// agree; otherwise it exits 1 and names the difference. A demo that claimed
// success it did not observe would contradict the layer it demonstrates.
//
// Nothing here is a benchmark or a measurement of benefit (see
// PREREGISTRATION.md for the evaluation that has not been run).

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const results = [];

const out = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => out(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const say = (s) => out(`  ${s}`);

/** Run one command, print it, its output and its exit code; record the observation. */
function run({ label, display, args, cwd = ROOT, input, expect, meaning }) {
  out(`\n$ ${display}`);
  const r = spawnSync(NODE, args, { cwd, input, encoding: 'utf8', env: { ...process.env } });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  if (text) out(text.split('\n').map((l) => `  ${l}`).join('\n'));
  const code = r.status === null ? `signal ${r.signal}` : r.status;
  out(`  exit=${code}   (expected ${expect})  ${code === expect ? 'OK' : 'DIFFERS'}`);
  say(`meaning: ${meaning}`);
  results.push({ label, expect, observed: code });
}

rule('evidence-admission: a narrated demo on synthetic data');
say('Three checks run where an agent\'s work enters a repository. Each one ends in');
say('an exit code, so a hook, a pipeline or a reviewer can act on it without');
say('reading prose. The data below is made up; the checks are the real ones.');

// ---------------------------------------------------------------- 1. resolver
rule('1. Figure resolver: does the number in the write-up match the run file?');
say('A figure in a memo carries a marker inside an HTML comment, naming the run');
say('file and the value it was copied from. Readers see only the figure:');
say('');
say('    The mean score was <!--[r:run.json#summary.score]-->0.873');
say('');
say('The resolver opens examples/run.json, reads summary.score and compares it');
say('with the written figure at the figure\'s own printed precision.');

run({
  label: 'resolver MATCH',
  display: 'node src/resolve-run-figures.mjs --evidence-root examples examples/memo-match.md',
  args: ['src/resolve-run-figures.mjs', '--evidence-root', 'examples', 'examples/memo-match.md'],
  expect: 0,
  meaning: 'every marked figure equals its run file; the memo may go forward.',
});
run({
  label: 'resolver MISMATCH',
  display: 'node src/resolve-run-figures.mjs --evidence-root examples examples/memo-mismatch.md',
  args: ['src/resolve-run-figures.mjs', '--evidence-root', 'examples', 'examples/memo-mismatch.md'],
  expect: 1,
  meaning: 'one figure was copied wrongly (0.837 for 0.873); the memo is refused.',
});
run({
  label: 'resolver UNRESOLVED',
  display: 'node src/resolve-run-figures.mjs --evidence-root examples examples/memo-missing.md',
  args: ['src/resolve-run-figures.mjs', '--evidence-root', 'examples', 'examples/memo-missing.md'],
  expect: 2,
  meaning: 'the cited run file does not exist, so the check could not happen. UNRESOLVED outranks MISMATCH and never passes quietly.',
});

// -------------------------------------------------------------- 2. push guard
rule('2. Push-ref guard: no direct push to a protected branch');
say('git hands a pre-push hook one line per ref update. The guard refuses any');
say('line whose remote ref is protected (default refs/heads/main), on any remote.');
say('Changes then reach main only through a reviewed pull request, unless the');
say('author bypasses the hook on purpose (EA_ALLOW_PROTECTED_PUSH=1 prints a notice).');

run({
  label: 'push to main',
  display: 'node src/check-push-ref.mjs < examples/push-main.in',
  args: ['src/check-push-ref.mjs'],
  input: readFileSync(path.join(ROOT, 'examples', 'push-main.in'), 'utf8'),
  expect: 1,
  meaning: 'the push would update refs/heads/main; refused.',
});
run({
  label: 'push to feature branch',
  display: 'node src/check-push-ref.mjs < examples/push-feature.in',
  args: ['src/check-push-ref.mjs'],
  input: readFileSync(path.join(ROOT, 'examples', 'push-feature.in'), 'utf8'),
  expect: 0,
  meaning: 'a feature branch is not protected; clear, no output.',
});

// --------------------------------------------------------------- 3. probe gate
rule('3. Probe-declaration gate: a commit touching runtime code must say what was probed');
say('The gate reads the staged file list from git, so this step creates a scratch');
say('repository in a temporary folder, stages one runtime file (src/a.mjs) and');
say('runs the gate with two commit messages from ./examples. The gate checks that');
say('a "Probes:" line exists, not that it is true; the truth stays the reviewer\'s job.');

let scratch = null;
try {
  scratch = mkdtempSync(path.join(tmpdir(), 'ea-demo-'));
  execFileSync('git', ['init', '-q'], { cwd: scratch, stdio: 'ignore' });
  mkdirSync(path.join(scratch, 'src'));
  writeFileSync(path.join(scratch, 'src', 'a.mjs'), 'export const a = 1;\n');
  execFileSync('git', ['add', 'src/a.mjs'], { cwd: scratch, stdio: 'ignore' });
  say(`scratch repository: ${scratch} (staged: src/a.mjs)`);
} catch (e) {
  say(`git is not available or the scratch repository could not be prepared: ${e.message}`);
  say('The gate step is skipped; the summary below records it as not run.');
  results.push({ label: 'probe gate (not run: no git)', expect: 'run', observed: 'skipped' });
}

if (scratch) {
  run({
    label: 'commit message without Probes:',
    display: 'node <ea>/src/check-probe-declaration.mjs <ea>/examples/commit-msg-without-probes.txt   # in the scratch repository',
    args: [path.join(ROOT, 'src', 'check-probe-declaration.mjs'), path.join(ROOT, 'examples', 'commit-msg-without-probes.txt')],
    cwd: scratch,
    expect: 1,
    meaning: 'runtime code is staged and no probe is declared; the commit is refused and the four questions are printed.',
  });
  run({
    label: 'commit message with Probes:',
    display: 'node <ea>/src/check-probe-declaration.mjs <ea>/examples/commit-msg-with-probes.txt      # in the scratch repository',
    args: [path.join(ROOT, 'src', 'check-probe-declaration.mjs'), path.join(ROOT, 'examples', 'commit-msg-with-probes.txt')],
    cwd: scratch,
    expect: 0,
    meaning: 'the declaration is present; accepted. What it declares is for the reviewer to check.',
  });
  rmSync(scratch, { recursive: true, force: true });
}

// ------------------------------------------------------------------- summary
rule('Summary: observed exit codes against the expected ones');
let differing = 0;
for (const r of results) {
  const ok = r.observed === r.expect;
  if (!ok) differing += 1;
  say(`${ok ? 'OK      ' : 'DIFFERS '} ${r.label.padEnd(36)} expected ${String(r.expect).padEnd(7)} observed ${r.observed}`);
}
out('');
say('Not shown here, by design: the hooks are client-side and bypassable; only');
say('MARKED figures are checked; no benefit has been measured. The evaluation');
say('that would measure it is a skeleton in PREREGISTRATION.md and has not run.');
say('To install the two hooks in a repository: node scripts/install-hooks.mjs [path].');
out('');
if (differing === 0) {
  out(`demo: ${results.length} of ${results.length} observed exit codes matched the expected ones.`);
  process.exit(0);
} else {
  out(`demo: ${differing} of ${results.length} observed exit codes DIFFER from the expected ones; this demo refuses to report success.`);
  process.exit(1);
}
