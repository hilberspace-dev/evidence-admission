# Examples

Every value in this folder is synthetic. Run the commands from the repository
root with Node 24.2 or later. The output below was observed on 4 October 2026
on Windows (Node 24.13.0, Git Bash); the absolute paths in it are that
machine's.

## Files

| File | Purpose |
|---|---|
| `run.json` | A synthetic run file: the evidence the memos cite. |
| `memo-match.md` | Four marked figures, all equal to `run.json`. Exit 0. |
| `memo-mismatch.md` | One marked figure copied wrongly (`0.837` for `0.873`). Exit 1. |
| `memo-missing.md` | A marker that points at a run file that does not exist. Exit 2. |
| `push-main.in` | The line git hands a pre-push hook for a push to `refs/heads/main`. |
| `push-feature.in` | The same push to `refs/heads/feature`. |
| `commit-msg-without-probes.txt` | A commit message with no `Probes:` line. |
| `commit-msg-with-probes.txt` | The same message with a `Probes:` line. |
| `evidence-admission.config.json` | Every configuration key at its default value (copy it to a repository root to change one). |

## Figure resolver

Markers in the memos are written inside HTML comments, so a rendered memo
shows only the figure. The marker names the file and the value; the figure
written after it is what gets checked:

```text
The mean score was <!--[r:run.json#summary.score]-->0.873
```

Expected exit codes: 0, 1, 2.

```text
$ node src/resolve-run-figures.mjs --evidence-root examples examples/memo-match.md
MATCH      examples/memo-match.md:3 [r:run.json#summary.count] — 1240
MATCH      examples/memo-match.md:4 [r:run.json#summary.score] — 0.873
MATCH      examples/memo-match.md:5 [r:run.json#rows[id=b].score] — 0.84
MATCH      examples/memo-match.md:6 [r:run.json#summary.latency_ms] — 41.6
resolve-run-figures: 4 markers in 1 inputs — 4 MATCH, 0 MISMATCH, 0 UNRESOLVED, 0 EXAMPLE (evidence root: C:\dev\evidence-admission\examples)
exit=0

$ node src/resolve-run-figures.mjs --evidence-root examples examples/memo-mismatch.md
MATCH      examples/memo-mismatch.md:3 [r:run.json#summary.count] — 1240
MISMATCH   examples/memo-mismatch.md:4 [r:run.json#summary.score] — found 0.873, written 0.837 (read as 0.837)
resolve-run-figures: 2 markers in 1 inputs — 1 MATCH, 1 MISMATCH, 0 UNRESOLVED, 0 EXAMPLE (evidence root: C:\dev\evidence-admission\examples)
exit=1

$ node src/resolve-run-figures.mjs --evidence-root examples examples/memo-missing.md
UNRESOLVED examples/memo-missing.md:3 [r:run-2.json#summary.score] — the file does not exist (C:\dev\evidence-admission\examples\run-2.json)
resolve-run-figures: 1 markers in 1 inputs — 0 MATCH, 0 MISMATCH, 1 UNRESOLVED, 0 EXAMPLE (evidence root: C:\dev\evidence-admission\examples)
exit=2
```

## Push-ref guard

Expected exit codes: 1 for the push to main, 0 for the feature branch, 0 with a
notice under the bypass flag.

```text
$ node src/check-push-ref.mjs < examples/push-main.in
[pre-push] blocked: this push would update a protected ref. Changes reach a protected ref only through a merged pull request; the bypass is EA_ALLOW_PROTECTED_PUSH=1.
  refs/heads/feature 0000000000000000000000000000000000000000 refs/heads/main 1111111111111111111111111111111111111111
exit=1

$ node src/check-push-ref.mjs < examples/push-feature.in
exit=0

$ EA_ALLOW_PROTECTED_PUSH=1 node src/check-push-ref.mjs < examples/push-main.in
[pre-push] EA_ALLOW_PROTECTED_PUSH=1 - push to a protected ref allowed by the bypass:
  refs/heads/feature 0000000000000000000000000000000000000000 refs/heads/main 1111111111111111111111111111111111111111
exit=0
```

## Probe-declaration gate

The gate reads the staged file list from git, so the example needs a
repository with a staged runtime file. Use a scratch directory outside this
repository; `<ea>` below is the path of this repository.

```sh
git init ea-demo && cd ea-demo
mkdir src && echo "export const a = 1;" > src/a.mjs && git add src/a.mjs
node <ea>/src/check-probe-declaration.mjs <ea>/examples/commit-msg-without-probes.txt   # exit 1
node <ea>/src/check-probe-declaration.mjs <ea>/examples/commit-msg-with-probes.txt      # exit 0
```

Observed:

```text
$ node <ea>/src/check-probe-declaration.mjs <ea>/examples/commit-msg-without-probes.txt

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

Runtime files staged without a Probes: line:
  src/a.mjs
exit=1

$ node <ea>/src/check-probe-declaration.mjs <ea>/examples/commit-msg-with-probes.txt
exit=0
```

Installed as a `commit-msg` hook (see the main README), git passes the message
file itself and the same check runs on every commit.
