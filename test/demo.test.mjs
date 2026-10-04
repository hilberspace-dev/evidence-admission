// Tests for scripts/demo.mjs: the passing arm (the demo observes the seven
// documented exit codes and exits 0) and the refusing arm (when the evidence
// no longer matches the memo, the demo exits 1 and names the difference
// instead of reporting success).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runDemo(cwd) {
  return spawnSync(process.execPath, [path.join('scripts', 'demo.mjs')], { cwd, encoding: 'utf8' });
}

test('the demo runs all seven commands, observes the documented exit codes and exits 0', () => {
  const r = runDemo(REPO_ROOT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const needle of [
    'MATCH ',
    'MISMATCH ',
    'UNRESOLVED ',
    '[pre-push] blocked',
    '[commit-msg] blocked',
    'exit=0   (expected 0)  OK',
    'exit=1   (expected 1)  OK',
    'exit=2   (expected 2)  OK',
    'demo: 7 of 7 observed exit codes matched the expected ones.',
  ]) {
    assert.ok(r.stdout.includes(needle), `missing in demo output: ${JSON.stringify(needle)}\n${r.stdout}`);
  }
  assert.ok(!r.stdout.includes('DIFFERS'), r.stdout);
});

test('refusing arm: when the run file no longer supports the matching memo, the demo exits 1 and names the difference', () => {
  const copy = mkdtempSync(path.join(tmpdir(), 'ea-demo-copy-'));
  try {
    for (const dir of ['src', 'scripts', 'examples']) {
      cpSync(path.join(REPO_ROOT, dir), path.join(copy, dir), { recursive: true });
    }
    writeFileSync(path.join(copy, 'package.json'), readFileSync(path.join(REPO_ROOT, 'package.json')));
    const runFile = path.join(copy, 'examples', 'run.json');
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    run.summary.score = 0.5; // memo-match.md still says 0.873
    writeFileSync(runFile, JSON.stringify(run, null, 2));

    const r = runDemo(copy);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('DIFFERS  resolver MATCH'), r.stdout);
    assert.ok(r.stdout.includes('observed exit codes DIFFER from the expected ones; this demo refuses to report success.'), r.stdout);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
