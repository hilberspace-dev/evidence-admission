// Push-ref guard. Run by .githooks/pre-push on the refs git hands the hook on
// stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line): any push
// that would move, create or delete a protected ref is refused unless
// EA_ALLOW_PROTECTED_PUSH=1. It exists for repositories where server-side branch
// protection is unavailable (for example a private repository on a plan without
// it), so "changes reach the protected branch only through a merged pull
// request" would otherwise be prose only.
//
// The protected set comes from `protectedRefs` in evidence-admission.config.json
// (default: refs/heads/main). The remote's NAME is ignored on purpose: a
// protected ref of any remote (a fork, a backup) is refused too.
//
// CLI entry is decided by `import.meta.main` (Node >= 24.2). An earlier version
// compared `fileURLToPath(import.meta.url)` with `process.argv[1]`; that
// comparison is FALSE when the working tree is entered through a directory
// junction or symlink (Node realpaths the module URL, argv[1] is only resolved),
// and the guard then exited 0 in silence. `import.meta.main` is true either way.
//
// Exit codes: 0 clear (or bypassed, with a notice), 1 refused.

import { DEFAULT_CONFIG, entryIsKnown, loadConfig } from './config.mjs';

export const PROTECTED_REMOTE_REFS = DEFAULT_CONFIG.protectedRefs;

/**
 * @param {string} stdinText the hook's stdin, one ref update per line
 * @param {NodeJS.ProcessEnv} env
 * @param {readonly string[]} protectedRefs
 * @returns {{ ok: boolean; reason: 'protected_ref' | 'bypassed' | 'clear'; refs: string[] }}
 */
export function evaluatePushRefs(stdinText, env = process.env, protectedRefs = PROTECTED_REMOTE_REFS) {
  const hits = [];
  for (const raw of String(stdinText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const remoteRef = parts[2] ?? '';
    if (protectedRefs.includes(remoteRef)) hits.push(line);
  }
  if (hits.length === 0) return { ok: true, reason: 'clear', refs: [] };
  if (env.EA_ALLOW_PROTECTED_PUSH === '1') return { ok: true, reason: 'bypassed', refs: hits };
  return { ok: false, reason: 'protected_ref', refs: hits };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** The CLI body, exported so a test can drive it without spawning; the spawned arm covers the entry itself. */
export async function runCli(stdinText, env = process.env, io = { stderr: process.stderr }, configDir = process.cwd()) {
  const loaded = loadConfig(configDir);
  if (!loaded.ok) {
    io.stderr.write(`[pre-push] blocked: the configuration cannot be read, refusing closed. ${loaded.error}\n`);
    return 1;
  }
  const verdict = evaluatePushRefs(stdinText, env, loaded.config.protectedRefs);
  if (verdict.reason === 'bypassed') {
    io.stderr.write(`[pre-push] EA_ALLOW_PROTECTED_PUSH=1 - push to a protected ref allowed by the bypass:\n  ${verdict.refs.join('\n  ')}\n`);
    return 0;
  }
  if (!verdict.ok) {
    io.stderr.write(`[pre-push] blocked: this push would update a protected ref. Changes reach a protected ref only through a merged pull request; the bypass is EA_ALLOW_PROTECTED_PUSH=1.\n  ${verdict.refs.join('\n  ')}\n`);
    return 1;
  }
  return 0;
}

if (!entryIsKnown(import.meta)) {
  process.stderr.write('[pre-push] import.meta.main is unavailable (Node >= 24.2.0 required); refusing closed.\n');
  process.exitCode = 1;
} else if (import.meta.main) {
  process.exitCode = await runCli(await readStdin());
}
