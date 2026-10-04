// Tests for src/check-probe-declaration.mjs: the pure decision, the
// classifier, and the CLI entry spawned inside a scratch git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateProbeDeclaration,
  listRuntimeStagedFiles,
  patternsFromConfig,
} from '../src/check-probe-declaration.mjs';
import { normaliseConfig } from '../src/config.mjs';

test('a runtime-touching commit without a Probes: line refuses, naming the files', () => {
  const verdict = evaluateProbeDeclaration({
    message: 'feat(x): wire the thing\n\nBody prose only.\n',
    stagedFiles: ['src/orders/intake.mjs', 'docs/api.yml'],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'missing_probe_declaration');
  assert.deepEqual(verdict.runtimeFiles, ['src/orders/intake.mjs']);
});

test('a Probes: declaration satisfies the gate; a bare "Probes: none" without a reason does not', () => {
  const staged = ['src/screens/Settings.tsx'];
  assert.equal(
    evaluateProbeDeclaration({
      message: 'feat: x\n\nProbes: dropped the input wire -> RED (201 vs expected 400)\n',
      stagedFiles: staged,
    }).ok,
    true,
  );
  assert.equal(
    evaluateProbeDeclaration({
      message: 'feat: x\n\nProbes: none - pure rename, no behaviour to probe\n',
      stagedFiles: staged,
    }).ok,
    true,
  );
  // "none" must carry its reason: an empty escape hatch is no gate at all.
  const bare = evaluateProbeDeclaration({ message: 'feat: x\n\nProbes: none\n', stagedFiles: staged });
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, 'bare_none_without_reason');
});

test('test-only and docs-only commits pass without a declaration under the defaults: tests ARE probes', () => {
  const verdict = evaluateProbeDeclaration({
    message: 'test(x): add the discriminating membership case\n',
    stagedFiles: [
      'src/orders/intake.test.mjs',
      'server/routes/health.spec.js',
      'docs/notes.md',
      'test/fixture.json',
    ],
  });
  assert.equal(verdict.ok, true);
});

test('merge, revert, fixup and squash commits are exempt even when runtime files are staged', () => {
  for (const message of ["Merge branch 'main' into x", 'Revert "feat: y"', 'fixup! feat: z', 'squash! feat: z']) {
    assert.equal(
      evaluateProbeDeclaration({ message, stagedFiles: ['server/app.mjs'] }).ok,
      true,
      message,
    );
  }
});

test('the default runtime classifier itself — the vacuity guard for every case above', () => {
  const classified = listRuntimeStagedFiles([
    'server/routes/x.mjs', // runtime
    'server/routes/x.test.mjs', // exempt: test
    'scripts/check-something.mjs', // runtime
    'lib/y.mjs', // runtime
    'src/pages/Z.tsx', // runtime
    'src/naïve-café.mjs', // runtime: a non-ASCII file name
    'src/pages/Z.spec.js', // exempt: test
    'docs/plan.md', // not a runtime path
    'test/helpers.mjs', // not a runtime path
    'srcx/not-a-match.mjs', // not a runtime path (the prefix needs its slash)
  ]);
  assert.deepEqual(classified, [
    'server/routes/x.mjs',
    'scripts/check-something.mjs',
    'lib/y.mjs',
    'src/pages/Z.tsx',
    'src/naïve-café.mjs',
  ]);
});

test('the classifier follows the configuration: custom runtime and exempt patterns replace the defaults', () => {
  const loaded = normaliseConfig({ runtimePathPattern: '^(app|\\.githooks)/', exemptPathPattern: '(\\.test\\.|\\.md$|\\.json$)' });
  assert.equal(loaded.ok, true);
  const patterns = patternsFromConfig(loaded.config);
  assert.deepEqual(
    listRuntimeStagedFiles(['app/a.mjs', 'app/a.test.mjs', 'app/README.md', 'app/data.json', '.githooks/commit-msg', 'src/b.mjs'], patterns),
    ['app/a.mjs', '.githooks/commit-msg'],
  );
  assert.equal(evaluateProbeDeclaration({ message: 'feat: x\n', stagedFiles: ['src/b.mjs'], patterns }).ok, true);
  assert.equal(evaluateProbeDeclaration({ message: 'feat: x\n', stagedFiles: ['app/a.mjs'], patterns }).ok, false);
});

test('a dangling "Probes:" with nothing on ITS OWN line refuses — the unfilled-template accident', () => {
  const staged = ['server/app.mjs'];
  // \s* would absorb the newline, so the NEXT line's first character would
  // satisfy \S and an unfilled template placeholder would sail through.
  assert.equal(
    evaluateProbeDeclaration({
      message: 'feat: x\n\nProbes:\nCo-Authored-By: Z <z@example.com>\n',
      stagedFiles: staged,
    }).ok,
    false,
  );
  // Same mechanism in the none-form: the dash at end of line with the "reason"
  // on the next line is not a same-line reason.
  assert.equal(
    evaluateProbeDeclaration({
      message: 'feat: x\n\nProbes: none -\nthe reason arrives one line late\n',
      stagedFiles: staged,
    }).ok,
    false,
  );
});

test('case and indentation do not refuse a GENUINE declaration (those edges fail open to the author, closed to emptiness)', () => {
  const staged = ['server/app.mjs'];
  assert.equal(
    evaluateProbeDeclaration({
      message: 'feat: x\n\nprobes: dropped the wire -> RED (saw 201)\n',
      stagedFiles: staged,
    }).ok,
    true,
  );
  assert.equal(
    evaluateProbeDeclaration({
      message: 'feat: x\n\n  Probes: mutated the guard -> RED (403 became 200)\n',
      stagedFiles: staged,
    }).ok,
    true,
  );
});

test('invalid input refuses', () => {
  assert.equal(evaluateProbeDeclaration({ message: null, stagedFiles: [] }).ok, false);
  assert.equal(evaluateProbeDeclaration({ message: 'x', stagedFiles: 'src/a.mjs' }).reason, 'invalid_input');
});

// ---- The CLI entry, spawned as the commit-msg hook spawns it, inside a
// scratch repository whose index holds a staged runtime file.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER_ABS = path.join(REPO_ROOT, 'src', 'check-probe-declaration.mjs');

function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ea-probe-repo-'));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  execFileSync('git', ['add', 'src/a.mjs'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(path.join(dir, 'msg-without.txt'), 'feat: add a\n');
  writeFileSync(path.join(dir, 'msg-with.txt'), 'feat: add a\n\nProbes: none - a constant export, nothing to vary\n');
  return dir;
}

function spawnGate(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CHECKER_ABS, ...args], {
    cwd,
    env: { ...process.env, EA_SKIP_PROBE_GATE: '', ...env },
    encoding: 'utf8',
  });
}

test('the CLI entry, spawned: no message-file argument refuses (exit 1); a staged runtime file without a Probes: line exits 1, with one exits 0', () => {
  const dir = scratchRepo();
  try {
    const noArg = spawnGate(dir, []);
    assert.equal(noArg.status, 1, `stdout: ${noArg.stdout}\nstderr: ${noArg.stderr}`);
    assert.match(noArg.stderr, /refusing./);
    const without = spawnGate(dir, ['msg-without.txt']);
    assert.equal(without.status, 1, without.stderr);
    assert.match(without.stderr, /declares no probes/);
    assert.match(without.stderr, /src\/a\.mjs/);
    const withLine = spawnGate(dir, ['msg-with.txt']);
    assert.equal(withLine.status, 0, withLine.stderr);
    const skipped = spawnGate(dir, ['msg-without.txt'], { EA_SKIP_PROBE_GATE: '1' });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stderr, /EA_SKIP_PROBE_GATE=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI reads the classifier from the repository configuration, and refuses closed when it is invalid', () => {
  const dir = scratchRepo();
  try {
    writeFileSync(path.join(dir, 'evidence-admission.config.json'), JSON.stringify({ runtimePathPattern: '^app/' }));
    const notRuntime = spawnGate(dir, ['msg-without.txt']);
    assert.equal(notRuntime.status, 0, `src/ is not runtime under this configuration; stderr: ${notRuntime.stderr}`);
    writeFileSync(path.join(dir, 'evidence-admission.config.json'), JSON.stringify({ runtimePathPattern: '^(app/' }));
    const invalid = spawnGate(dir, ['msg-with.txt']);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /not a valid regular expression/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a staged DELETION of a runtime file needs no declaration: the lister uses --diff-filter=ACMR', () => {
  const dir = scratchRepo();
  try {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'feat: add a\n\nProbes: none - fixture'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['rm', '-q', 'src/a.mjs'], { cwd: dir, stdio: 'ignore' });
    const deletion = spawnGate(dir, ['msg-without.txt']);
    assert.equal(deletion.status, 0, `a deletion-only commit must pass without a Probes: line; stderr: ${deletion.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
