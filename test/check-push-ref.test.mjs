// Tests for src/check-push-ref.mjs: the pure function, the CLI body, the
// spawned CLI entry and, on Windows, the entry through a directory junction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatePushRefs, runCli, PROTECTED_REMOTE_REFS } from '../src/check-push-ref.mjs';

const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);
const MAIN_LINE = `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`;
const FEATURE_LINE = `refs/heads/feat/x ${SHA} refs/heads/feat/x ${SHA}\n`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER_REL = path.join('src', 'check-push-ref.mjs');

function configDir(config) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ea-push-config-'));
  writeFileSync(path.join(dir, 'evidence-admission.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

test('a push that updates refs/heads/main is refused, naming the ref line', () => {
  const v = evaluatePushRefs(MAIN_LINE, {});
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'protected_ref');
  assert.equal(v.refs.length, 1);
});

test('a push from a feature branch TO refs/heads/main is refused too (the remote ref decides, not the local one)', () => {
  const v = evaluatePushRefs(`refs/heads/feat/x ${SHA} refs/heads/main ${SHA}\n`, {});
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'protected_ref');
});

test('deleting refs/heads/main (zero local sha) is refused', () => {
  const v = evaluatePushRefs(`(delete) ${ZERO} refs/heads/main ${SHA}\n`, {});
  assert.equal(v.ok, false);
});

test('a push to a feature branch is clear (vacuity arm), including names that merely contain or END with "main"', () => {
  const v = evaluatePushRefs(
    `${FEATURE_LINE}refs/heads/main-docs ${SHA} refs/heads/main-docs ${SHA}\nrefs/heads/feat/main ${SHA} refs/heads/feat/main ${SHA}\n`,
    {},
  );
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'clear');
  assert.deepEqual(v.refs, []);
});

test('the bypass EA_ALLOW_PROTECTED_PUSH=1 allows it, says so and still names the ref; any other value does not', () => {
  const bypassed = evaluatePushRefs(MAIN_LINE, { EA_ALLOW_PROTECTED_PUSH: '1' });
  assert.equal(bypassed.reason, 'bypassed');
  assert.deepEqual(bypassed.refs, [MAIN_LINE.trim()]);
  assert.equal(evaluatePushRefs(MAIN_LINE, { EA_ALLOW_PROTECTED_PUSH: 'true' }).ok, false);
  assert.equal(evaluatePushRefs(MAIN_LINE, { EA_ALLOW_PROTECTED_PUSH: '01' }).ok, false);
});

test('empty stdin (nothing to push: an up-to-date push hands the hook no lines) is clear', () => {
  assert.equal(evaluatePushRefs('', {}).ok, true);
});

test('the default protected set is exactly refs/heads/main (a sentence about a gate may not exceed the gate)', () => {
  assert.deepEqual([...PROTECTED_REMOTE_REFS], ['refs/heads/main']);
});

test('a configured protected set is honoured: a release branch is refused, main still is', () => {
  const refs = ['refs/heads/main', 'refs/heads/release'];
  assert.equal(evaluatePushRefs(`refs/heads/x ${SHA} refs/heads/release ${SHA}\n`, {}, refs).ok, false);
  assert.equal(evaluatePushRefs(MAIN_LINE, {}, refs).ok, false);
  assert.equal(evaluatePushRefs(FEATURE_LINE, {}, refs).ok, true);
});

test('runCli returns 1 and writes the blocked line for main, 0 for a feature branch, 0 with the notice under the bypass', async () => {
  const out = [];
  const io = { stderr: { write: (s) => out.push(s) } };
  assert.equal(await runCli(MAIN_LINE, {}, io, REPO_ROOT), 1);
  assert.match(out.at(-1), /blocked: this push would update a protected ref/);
  assert.equal(await runCli(FEATURE_LINE, {}, io, REPO_ROOT), 0);
  assert.equal(await runCli(MAIN_LINE, { EA_ALLOW_PROTECTED_PUSH: '1' }, io, REPO_ROOT), 0);
  assert.match(out.at(-1), /EA_ALLOW_PROTECTED_PUSH=1/);
});

test('runCli reads protectedRefs from the configuration file, and refuses closed when the file is invalid', async () => {
  const out = [];
  const io = { stderr: { write: (s) => out.push(s) } };
  const good = configDir({ protectedRefs: ['refs/heads/release'] });
  const bad = configDir('{ "protectedRefs": "refs/heads/main" }');
  try {
    assert.equal(await runCli(`refs/heads/x ${SHA} refs/heads/release ${SHA}\n`, {}, io, good), 1);
    assert.equal(await runCli(MAIN_LINE, {}, io, good), 0, 'main is not in the configured set');
    assert.equal(await runCli(FEATURE_LINE, {}, io, bad), 1);
    assert.match(out.at(-1), /configuration cannot be read/);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

function spawnChecker(cwd, input, env = {}) {
  return spawnSync(process.execPath, [CHECKER_REL], { cwd, input, env: { ...process.env, EA_ALLOW_PROTECTED_PUSH: '', ...env }, encoding: 'utf8' });
}

test('the CLI entry, spawned as the hook spawns it: main on stdin exits 1 with the blocked line; a feature branch exits 0', () => {
  const blocked = spawnChecker(REPO_ROOT, MAIN_LINE);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /blocked: this push would update a protected ref/);
  const clear = spawnChecker(REPO_ROOT, FEATURE_LINE);
  assert.equal(clear.status, 0, clear.stderr);
  assert.equal(clear.stderr, '');
  const bypassed = spawnChecker(REPO_ROOT, MAIN_LINE, { EA_ALLOW_PROTECTED_PUSH: '1' });
  assert.equal(bypassed.status, 0, bypassed.stderr);
  assert.match(bypassed.stderr, /EA_ALLOW_PROTECTED_PUSH=1/);
});

test('the CLI entry still fires when the tree is entered through a directory junction (argv[1] vs the realpathed module URL)', (t) => {
  if (process.platform !== 'win32') { t.skip('junction probe is Windows-only; the realpath class is covered by import.meta.main on every platform'); return; }
  const base = mkdtempSync(path.join(tmpdir(), 'ea-guard-junction-'));
  const junction = path.join(base, 'wt');
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', junction, REPO_ROOT], { stdio: 'ignore' });
  } catch (err) {
    rmSync(base, { recursive: true, force: true });
    t.skip(`could not create a junction here: ${err.message}`);
    return;
  }
  try {
    const blocked = spawnChecker(junction, MAIN_LINE);
    assert.equal(blocked.status, 1, `through the junction the guard must still block; stderr: ${blocked.stderr}`);
    assert.match(blocked.stderr, /blocked: this push would update a protected ref/);
  } finally {
    // The junction itself is removed first (never the target's contents), then the temp dir.
    try { execFileSync('cmd', ['/c', 'rmdir', junction], { stdio: 'ignore' }); } catch { /* rmSync handles it */ }
    rmSync(base, { recursive: true, force: true });
  }
});
