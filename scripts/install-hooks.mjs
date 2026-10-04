// Point git at this package's hooks by setting core.hooksPath.
//
//   node scripts/install-hooks.mjs              this repository: core.hooksPath = .githooks
//   node scripts/install-hooks.mjs <repo-dir>   another repository: core.hooksPath = the
//                                               absolute path of this package's .githooks
//
// core.hooksPath REPLACES the repository's own .git/hooks directory; any hook
// already installed there stops running. The command prints the previous value.
// Undo with: git config --unset core.hooksPath

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = path.join(PACKAGE_ROOT, '.githooks');
const HOOKS = ['commit-msg', 'pre-push'];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main(argv) {
  const target = argv[0] ? path.resolve(argv[0]) : PACKAGE_ROOT;
  if (!existsSync(target)) {
    process.stderr.write(`install-hooks: ${target} does not exist\n`);
    return 1;
  }
  for (const hook of HOOKS) {
    const file = path.join(HOOKS_DIR, hook);
    if (!existsSync(file)) {
      process.stderr.write(`install-hooks: missing hook ${file}\n`);
      return 1;
    }
    // Git on Linux and macOS runs a hook only when it is executable.
    if (process.platform !== 'win32') chmodSync(file, 0o755);
  }
  let top;
  try {
    top = git(target, ['rev-parse', '--show-toplevel']);
  } catch {
    process.stderr.write(`install-hooks: ${target} is not inside a git working tree\n`);
    return 1;
  }
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const value = same(path.resolve(top), PACKAGE_ROOT) ? '.githooks' : HOOKS_DIR;
  let previous = '';
  try { previous = git(top, ['config', '--get', 'core.hooksPath']); } catch { /* unset */ }
  git(top, ['config', 'core.hooksPath', value]);
  process.stdout.write(`core.hooksPath = ${value} in ${top}${previous ? ` (was ${previous})` : ''}\n`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
