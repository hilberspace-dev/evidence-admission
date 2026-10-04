# evidence-admission

An evidence-admission layer for agent-run computational research: three small
checks that run where an agent's work enters a repository. A marked figure in
a write-up must resolve to the run file it was copied from; a commit that
touches runtime code must declare what was probed; a client-side hook refuses
a direct push to a protected branch, so that changes reach it through a pull
request unless the author bypasses the hook on purpose. Nothing else is checked
here (see "Limits").

**Origin.** Extracted on 4 October 2026 from the governance tooling of one
private computational research programme, where the original checkers have
been in daily use since September 2026. This extract (renamed flags, a
configuration file, changed probe-gate defaults) has so far run only in its own
tests; no external users yet. Version 0.1.0. Zero dependencies.

## The three executable checks

**Figure resolver** (`src/resolve-run-figures.mjs`). A figure written in a
memo, report or pull-request body can carry a marker naming the run file and
the value it was copied from, for example
`<!--[r:run.json#summary.score]-->0.873` (the HTML comment keeps the rendered
text clean). The resolver reads every marker, looks the value up (a JSON path,
a `[key=value]` row, or a regex with one capture group in a text file),
compares it with the written figure at the figure's own printed precision, and
reports each marker as MATCH, MISMATCH, UNRESOLVED or EXAMPLE (syntax quoted as
code). Exit codes: **0** every marker matches, **1** at least one MISMATCH,
**2** at least one UNRESOLVED (a missing file, a selector that finds nothing or
finds two values, an unreadable marker, an unclosed code fence) or a usage
error. UNRESOLVED outranks MISMATCH because it means the check did not happen.

```sh
node src/resolve-run-figures.mjs --evidence-root <dir> report.md [more.md …]
```

**Push-ref guard** (`src/check-push-ref.mjs`, run by `.githooks/pre-push`).
Reads the ref lines git gives a pre-push hook and refuses any push that would
update, create or delete a protected ref (default `refs/heads/main`) on any
remote, so that a change reaches it through a pull request unless the author
bypasses the hook on purpose. It is a client-side stand-in for repositories
where server-side branch protection is not available. Exit codes:
**0** clear (or bypassed with `EA_ALLOW_PROTECTED_PUSH=1`, which prints a
notice), **1** refused.

**Probe-declaration gate** (`src/check-probe-declaration.mjs`, run by
`.githooks/commit-msg`). A commit that stages runtime files must say what was
probed, on a line of its own: `Probes: <what was mutated> -> RED (<observed
failure>)` or `Probes: none - <reason>`. A bare `Probes: none` and an empty
`Probes:` are refused. Merge, revert, fixup and squash commits, deletions and
exempt files (by default `.test.js`, `.test.mjs`, `.spec.js` and `.spec.mjs`
files) never need the line. The gate checks that the
declaration is present, not that it is true; that stays the reviewer's job.
Exit codes: **0** accepted (or skipped with `EA_SKIP_PROBE_GATE=1`), **1**
refused.

Each CLI decides that it is the entry point with `import.meta.main`. The older
comparison of `process.argv[1]` with `import.meta.url` is false when the
working tree is entered through a directory junction or symlink, and a checker
written that way exits 0 without checking anything. The test suite has a
Windows junction arm for the push guard that fails when the old comparison is
put back.

`examples/README.md` lists commands for each check with their observed output
and exit codes.

## The rest of the layer is not enforced here

The layer these checks come from also has rules that this repository does
**not** implement or enforce by machine. They are described here so the scope
is clear:

- **Review bound to a revision.** A review applies to one exact tree; any
  change after it reopens the review.
- **Plan immutability.** A pre-registered plan or acceptance criterion is not
  edited after outcomes are seen; changes are dated, append-only amendments.
- **Recorded approvals.** Decisions the agent may not take alone are taken by a
  named person and recorded.
- **First-hand reopening.** A claim reported by an agent or reviewer is
  treated as unverified until its cited location has been opened and read.

In the source programme these are prescribed in writing and recorded in logs;
here they are not checked at all.

## Install

Requirements: Node 24.2.0 or later and git. The CLIs rely on `import.meta.main`,
which Node's documentation still marks as early-development; if its behaviour
changes, the checks refuse rather than silently pass.

```sh
# in this repository
node scripts/install-hooks.mjs            # or: npm run install-hooks

# in another repository: point its core.hooksPath at this package's .githooks
node scripts/install-hooks.mjs /path/to/other-repo
```

`core.hooksPath` replaces the repository's `.git/hooks` directory, so hooks
already installed there stop running; the installer prints the previous value.
Undo with `git config --unset core.hooksPath`.

## Configuration

An optional `evidence-admission.config.json` at the repository root overrides
any of these defaults. An unknown key, a wrong type or an invalid regular
expression makes every check refuse rather than fall back to the defaults.

| Key | Default | Used by |
|---|---|---|
| `protectedRefs` | `["refs/heads/main"]` | push guard |
| `runtimePathPattern` | `^(src\|server\|scripts\|lib)/` | probe gate: staged paths that need a declaration |
| `exemptPathPattern` | `\.(test\|spec)\.m?js$` | probe gate: runtime paths that do not |
| `evidenceRoot` | `.evidence/` | resolver: where marker paths resolve (overridden by `EA_EVIDENCE_ROOT` or `--evidence-root`) |
| `trackedPathPattern` | `^docs/` | resolver: marker paths that resolve against the repository root instead |

`examples/evidence-admission.config.json` holds every key at its default.

## Limits

- The hooks are client-side and bypassable: `git commit --no-verify`,
  `git push --no-verify`, the documented flags `EA_SKIP_PROBE_GATE=1` and
  `EA_ALLOW_PROTECTED_PUSH=1`, or unsetting `core.hooksPath`. They make a
  bypass deliberate; they do not make it impossible.
- The resolver checks only **marked** figures. An unmarked number is not
  checked, and the resolver cannot tell that a marker is missing.
- The resolver is not a hook. Run files are often untracked, so it is run by
  hand or in a pipeline that has the run files.
- The probe gate checks that a declaration exists, not that the probe was run.
- `--pr <number>` on the resolver calls the GitHub CLI (`gh`) and is not
  covered by the tests.
- Node 24.2.0 or later is required (`import.meta.main`; Node 22.18 or later
  also has it). Where `import.meta.main` is undefined the three checks refuse
  rather than silently pass; the hook installer does not check the Node version
  (on an older Node it exits 0 and installs nothing).
- The test suite has been run on Windows only. The CI workflow for Ubuntu and
  Windows is included but has not run yet.
- There is no measurement of benefit. `PREREGISTRATION.md` is a skeleton for
  the evaluation that would test whether these checks reduce unsupported
  claims; nothing in it has been run.

## Tests

```sh
npm test
```

## Licence

MIT. Copyright (c) 2026 Serhat Atılgan. See `LICENSE`.
