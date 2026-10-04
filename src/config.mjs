// Optional repository configuration for the three checkers.
//
// A repository may place `evidence-admission.config.json` at its root. Every key
// is optional; a missing file means the defaults below. A file that does not
// parse, carries an unknown key or a value of the wrong type is an ERROR, never
// a silent fallback to the defaults: a typo in a gate's configuration must not
// quietly turn the gate off. Each CLI refuses with its failure exit code when
// the configuration cannot be read.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = 'evidence-admission.config.json';

export const DEFAULT_CONFIG = Object.freeze({
  /** Remote refs the push guard refuses to update, create or delete. */
  protectedRefs: Object.freeze(['refs/heads/main']),
  /** Staged paths matching this make a commit "runtime-touching" for the probe gate. */
  runtimePathPattern: '^(src|server|scripts|lib)/',
  /** Staged runtime paths matching this do not demand a declaration on their own (tests are probes). */
  exemptPathPattern: '\\.(test|spec)\\.m?js$',
  /** Where run files live; marker paths resolve against it. Relative to the main checkout's root. */
  evidenceRoot: '.evidence/',
  /** Marker paths matching this resolve against the REPOSITORY root instead of the evidence root. */
  trackedPathPattern: '^docs/',
});

const STRING_KEYS = ['runtimePathPattern', 'exemptPathPattern', 'evidenceRoot', 'trackedPathPattern'];
const PATTERN_KEYS = ['runtimePathPattern', 'exemptPathPattern', 'trackedPathPattern'];

/**
 * Validate a parsed configuration object and merge it over the defaults.
 * @returns {{ ok: true, config: typeof DEFAULT_CONFIG } | { ok: false, error: string }}
 */
export function normaliseConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'the configuration must be a JSON object' };
  }
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown configuration key(s): ${unknown.join(', ')}` };
  }
  const config = { ...DEFAULT_CONFIG };
  if ('protectedRefs' in raw) {
    const refs = raw.protectedRefs;
    if (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string' || !r.startsWith('refs/'))) {
      return { ok: false, error: 'protectedRefs must be an array of full ref names starting with "refs/"' };
    }
    config.protectedRefs = [...refs];
  }
  for (const key of STRING_KEYS) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== 'string' || raw[key].length === 0) {
      return { ok: false, error: `${key} must be a non-empty string` };
    }
    config[key] = raw[key];
  }
  for (const key of PATTERN_KEYS) {
    try {
      new RegExp(config[key]);
    } catch (err) {
      return { ok: false, error: `${key} is not a valid regular expression: ${err.message}` };
    }
  }
  return { ok: true, config };
}

/**
 * Read `evidence-admission.config.json` from `dir` (default: the current
 * directory, which is the working-tree root when git runs a hook).
 */
export function loadConfig(dir = process.cwd()) {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) return { ok: true, config: { ...DEFAULT_CONFIG }, file: null };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, error: `${file} does not parse: ${err.message}` };
  }
  const out = normaliseConfig(raw);
  return out.ok ? { ...out, file } : { ok: false, error: `${file}: ${out.error}` };
}

/**
 * `import.meta.main` exists from Node 24.2.0. On an older runtime it is
 * undefined, a CLI would never see itself as the entry point, and the checker
 * would exit 0 without checking anything. Each CLI calls this first and fails
 * closed instead.
 */
export function entryIsKnown(meta) {
  return typeof meta.main === 'boolean';
}
