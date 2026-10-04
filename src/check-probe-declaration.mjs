// The probe-declaration gate. Run by .githooks/commit-msg.
//
// WHY THIS EXISTS. In the programme this was extracted from, several
// independent-review findings in one day shared one mechanism: each change's
// verification certified the case its author CONSTRUCTED, and the rival case
// that would falsify the claim was never built. The rules already existed; the
// failure was RECOGNITION at the moment of test design. The machine half is a
// forced declaration at commit time: a commit touching runtime code must SAY
// what was probed. The declaration's truth stays the reviewer's to check; the
// gate buys the recognition moment, not the proof.
//
// Which staged paths are "runtime" and which are exempt comes from
// evidence-admission.config.json (`runtimePathPattern`, `exemptPathPattern`).
// Deletions are exempt by the ACMR filter below.
//
// Exit codes: 0 accepted (or skipped with EA_SKIP_PROBE_GATE=1), 1 refused.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { DEFAULT_CONFIG, entryIsKnown, loadConfig } from './config.mjs';

/** The default classifier, compiled from the documented defaults. */
export const DEFAULT_PATTERNS = Object.freeze({
  runtimePathRe: new RegExp(DEFAULT_CONFIG.runtimePathPattern),
  exemptFileRe: new RegExp(DEFAULT_CONFIG.exemptPathPattern),
});

/** Compile the classifier from a loaded configuration. */
export function patternsFromConfig(config) {
  return {
    runtimePathRe: new RegExp(config.runtimePathPattern),
    exemptFileRe: new RegExp(config.exemptPathPattern),
  };
}

/** Commit shapes the gate never questions. */
const EXEMPT_MESSAGE_RE = /^(Merge |Revert |fixup!|squash!)/;

// Same-line content only: `\s*` would absorb the newline, so an UNFILLED
// template placeholder ("Probes:" with the declaration never written) would be
// satisfied by the next line's first character. `[^\S\r\n]` is horizontal
// whitespace. Case-insensitive and indent-tolerant: those edges fail open to a
// genuine author and closed to emptiness.
const PROBE_LINE_RE = /^[^\S\r\n]*Probes:[^\S\r\n]*\S/im;
const PROBE_NONE_HEAD_RE = /^[^\S\r\n]*Probes:[^\S\r\n]*none\b/im;
const PROBE_NONE_RE = /^[^\S\r\n]*Probes:[^\S\r\n]*none[^\S\r\n]*[-–—][^\S\r\n]*\S/im;

export function listRuntimeStagedFiles(stagedFiles, patterns = DEFAULT_PATTERNS) {
  return stagedFiles.filter(
    (file) => patterns.runtimePathRe.test(file) && !patterns.exemptFileRe.test(file),
  );
}

/**
 * Pure decision: does this commit message satisfy the gate for these staged
 * files? Returns { ok: true } or { ok: false, reason, runtimeFiles }.
 */
export function evaluateProbeDeclaration({ message, stagedFiles, patterns = DEFAULT_PATTERNS }) {
  if (typeof message !== 'string' || !Array.isArray(stagedFiles)) {
    return { ok: false, reason: 'invalid_input', runtimeFiles: [] };
  }
  if (EXEMPT_MESSAGE_RE.test(message.trimStart())) {
    return { ok: true };
  }
  const runtimeFiles = listRuntimeStagedFiles(stagedFiles, patterns);
  if (runtimeFiles.length === 0) {
    return { ok: true };
  }
  const probeLine = message.match(PROBE_LINE_RE);
  if (probeLine) {
    // A bare "Probes: none" is an empty escape hatch, not a declaration: the
    // none-form must carry its reason ON THE SAME LINE.
    if (PROBE_NONE_HEAD_RE.test(message) && !PROBE_NONE_RE.test(message)) {
      return { ok: false, reason: 'bare_none_without_reason', runtimeFiles };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'missing_probe_declaration', runtimeFiles };
}

const GUIDANCE = `
[commit-msg] blocked: this commit touches runtime code but declares no probes.

Add ONE of these to the commit message:
  Probes: <what you mutated/varied> -> RED (<the observed failure>)
  Probes: none - <why no probe applies to this commit>

Before writing the line, answer what the declaration exists to force:
 1. Name the rival mechanism that would make this commit's headline claim false.
 2. A negative test pins nothing unless its input SUCCEEDS under the rival -
    an input refused by both candidate sources is a vacuous probe.
 3. Mutate the seam you JUST wired and watch the RED. Recency ("I just built
    it, it is obviously connected") is exactly why that seam goes unprobed.
 4. Scope regressions by the changed file's CONSUMERS (its importers and
    callers), not by its path.

Emergency bypass (leaves no declaration for the reviewer - prefer the line):
  EA_SKIP_PROBE_GATE=1 git commit ...
`;

function main() {
  if (process.env.EA_SKIP_PROBE_GATE === '1') {
    process.stderr.write('[commit-msg] EA_SKIP_PROBE_GATE=1 - probe gate skipped.\n');
    return 0;
  }
  const messageFile = process.argv[2];
  if (!messageFile) {
    process.stderr.write('[commit-msg] no commit message file argument; refusing.\n');
    return 1;
  }
  const loaded = loadConfig(process.cwd());
  if (!loaded.ok) {
    process.stderr.write(`[commit-msg] the configuration cannot be read; refusing closed. ${loaded.error}\n`);
    return 1;
  }
  const message = readFileSync(messageFile, 'utf8');
  let stagedFiles;
  try {
    // core.quotepath=false: without it git octal-quotes non-ASCII paths
    // ("src/\303\266..."), the leading quote defeats the path pattern, and a
    // runtime file with a non-ASCII name escapes the gate entirely.
    stagedFiles = execFileSync(
      'git',
      ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'],
      { encoding: 'utf8' },
    )
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    process.stderr.write('[commit-msg] could not read the staged file list from git; refusing closed.\n');
    return 1;
  }
  const verdict = evaluateProbeDeclaration({ message, stagedFiles, patterns: patternsFromConfig(loaded.config) });
  if (verdict.ok) return 0;
  process.stderr.write(GUIDANCE);
  process.stderr.write(`\nRuntime files staged without a Probes: line:\n  ${verdict.runtimeFiles.join('\n  ')}\n`);
  return 1;
}

// CLI entry is decided by `import.meta.main` (Node >= 24.2), as in
// check-push-ref.mjs: an exact URL comparison with argv[1] is FALSE when the
// working tree is entered through a directory junction or symlink, and the gate
// then exits 0 in silence.
if (!entryIsKnown(import.meta)) {
  process.stderr.write('[commit-msg] import.meta.main is unavailable (Node >= 24.2.0 required); refusing closed.\n');
  process.exitCode = 1;
} else if (import.meta.main) {
  process.exit(main());
}
