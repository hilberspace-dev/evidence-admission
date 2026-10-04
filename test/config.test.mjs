// Tests for src/config.mjs: defaults, validation, and fail-closed loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CONFIG_FILE, DEFAULT_CONFIG, entryIsKnown, loadConfig, normaliseConfig } from '../src/config.mjs';

function withConfig(text, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ea-config-'));
  try {
    if (text !== null) writeFileSync(path.join(dir, CONFIG_FILE), text);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the documented defaults', () => {
  assert.deepEqual([...DEFAULT_CONFIG.protectedRefs], ['refs/heads/main']);
  assert.equal(DEFAULT_CONFIG.runtimePathPattern, '^(src|server|scripts|lib)/');
  assert.equal(DEFAULT_CONFIG.exemptPathPattern, '\\.(test|spec)\\.m?js$');
  assert.equal(DEFAULT_CONFIG.evidenceRoot, '.evidence/');
  assert.equal(DEFAULT_CONFIG.trackedPathPattern, '^docs/');
});

test('no configuration file means the defaults', () => {
  withConfig(null, (dir) => {
    const out = loadConfig(dir);
    assert.equal(out.ok, true);
    assert.equal(out.file, null);
    assert.deepEqual(out.config, { ...DEFAULT_CONFIG });
  });
});

test('a partial configuration overrides only the keys it names', () => {
  withConfig(JSON.stringify({ protectedRefs: ['refs/heads/main', 'refs/heads/release'], evidenceRoot: 'runs/' }), (dir) => {
    const out = loadConfig(dir);
    assert.equal(out.ok, true);
    assert.deepEqual(out.config.protectedRefs, ['refs/heads/main', 'refs/heads/release']);
    assert.equal(out.config.evidenceRoot, 'runs/');
    assert.equal(out.config.runtimePathPattern, DEFAULT_CONFIG.runtimePathPattern);
  });
});

test('an invalid configuration is an error, never a silent fallback to the defaults', () => {
  const cases = [
    ['{ not json', /does not parse/],
    ['[]', /must be a JSON object/],
    ['{ "protectedRef": ["refs/heads/main"] }', /unknown configuration key\(s\): protectedRef/],
    ['{ "protectedRefs": "refs/heads/main" }', /protectedRefs must be an array/],
    ['{ "protectedRefs": ["main"] }', /starting with "refs\/"/],
    ['{ "runtimePathPattern": "" }', /must be a non-empty string/],
    ['{ "exemptPathPattern": "(" }', /not a valid regular expression/],
    ['{ "evidenceRoot": 3 }', /must be a non-empty string/],
  ];
  for (const [text, reason] of cases) {
    withConfig(text, (dir) => {
      const out = loadConfig(dir);
      assert.equal(out.ok, false, text);
      assert.match(out.error, reason, text);
    });
  }
});

test('normaliseConfig accepts the full documented shape', () => {
  const out = normaliseConfig({
    protectedRefs: ['refs/heads/main'],
    runtimePathPattern: '^src/',
    exemptPathPattern: '\\.test\\.mjs$',
    evidenceRoot: '.evidence/',
    trackedPathPattern: '^docs/',
  });
  assert.equal(out.ok, true);
});

test('entryIsKnown is true on this runtime (Node >= 24.2.0) and false when import.meta.main is absent', () => {
  assert.equal(entryIsKnown(import.meta), true);
  assert.equal(entryIsKnown({}), false);
});
