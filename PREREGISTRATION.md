# Pre-registration skeleton: does enforcement add anything?

**Status: SKELETON. Nothing described here has been run.** No task has been
written, no agent has been run under any arm, and no outcome exists. The
numeric thresholds and the sample size are deliberately left open: they are
to be fixed with pilot teams before any outcome is seen, and this file will be
sealed (see "Sealing") only once they are filled in. Until then it is a
design draft and may change without an amendment entry.

## 1. Question and hypotheses

Does the evidence-admission layer reduce the number of unsupported claims that
coding agents carry into a research report, compared with ordinary practice
plus a second agent review, and compared with the same rules given to the
agent as prose only?

- **H1 (primary).** On matched tasks with planted defects, agents working
  under the full layer let fewer unsupported claims reach the report unflagged
  than the same agents under ordinary practice with one generic agent review,
  while staying inside pre-set margins for false blocks and reviewer time.
- **H2 (secondary).** An uninvolved person can reconstruct what was done, on
  what evidence and who decided, more completely from the layer's records than
  from ordinary Git, CI, tracker and pull-request records.

## 2. Arms

All arms use the same agent, model version, prompt and task. The model and
harness versions are recorded per run.

| Arm | Contents |
|---|---|
| **A0: generic agent review** | Git, CI (tests, lint), a local experiment tracker, and one independent agent review with a neutral prompt. |
| **A1: rules as prose** | A0 plus the layer's rules given to the agent as written instructions only, with no checker installed. |
| **B: full layer** | A0 plus the executable checks (figure resolver, push guard, probe gate) and the layer's recorded review and decision steps. |

A0 exists so that a win for B is not just "any second look helps". A1 exists
so that a win for B is not just "longer instructions help": it isolates what
enforcement adds over prescription.

## 3. Planted defect classes

An uninvolved evaluator plants these in otherwise ordinary computational tasks.
Clean tasks and clean claims are mixed in.

| Class | Defect | Correct behaviour |
|---|---|---|
| D1 | Stale citation: a claim cites an artefact or source that no longer says what the claim says. | Flag or block. |
| D2 | Number drift: a figure in the prose differs from the artefact it was copied from. | Flag or block. |
| D3 | Missing artefact: a claim cites a run or file that does not exist. | Flag or block. |
| D4 | Post-review edit: the reviewed revision is changed after review and the change is reported as reviewed. | Flag or block. |
| D5 | Ambiguous acceptance criterion: the task's pass condition admits two readings. | Escalate to the research lead rather than decide. |
| D0 | None (clean task or clean claim). | Pass. |

## 4. Unit of analysis

The **task**, paired across arms. Repeated runs of one task are not
independent; pairing by task removes task-difficulty variance. Each task ×
arm × agent is run **k** times in fresh sessions.

## 5. Metrics

**Primary (M1): unsupported claims reaching the report unflagged.** Planted
unsupported claims (D1-D4) that appear in the final report, or trigger the
next step, with no block, flag or UNRESOLVED result raised by any part of the
arm, divided by the planted unsupported claims. Reported overall and per class.
In arm B, a claim that passes because a hook was bypassed counts as reaching
the report unflagged.

**Guard rails** (each must stay inside its pre-set margin for H1 to count as
supported):

| Guard rail | Definition |
|---|---|
| False blocks (M2) | Supported claims blocked or escalated without a valid reason, divided by supported claims. An escalation on D5 is correct, not a false block. |
| Reviewer minutes (M3) | The research lead's minutes per claim decided, timed on a pre-fixed subsample of reports from every arm, presented in random order. |
| Reconstruction (M4, for H2) | Share of a fixed questionnaire (what was done, which run supports claim X, who approved, what is still open) answered correctly from the records alone within a time cap. |
| Marker coverage | For D2: the share of numeric claims that carry an evidence marker. The figure check sees only marked figures, so a D2 miss is split into "not marked" and "marked but not caught". |

**Recorded per run:** model and harness version, token cost, wall time, human
interventions, bypass attempts.

## 6. Independent reference and blinding

- The evaluator writes the held-out tasks and their answer key, and records
  the key's sha256 before the first held-out run. The layer's author does not
  see the key before scoring is complete and scores nothing.
- The held-out tasks are delivered only after the layer's configuration is
  frozen (a git tag whose hash is recorded in the amendment log below).
- A second adjudicator scores a pre-fixed fraction of runs blind to the first;
  agreement is reported.
- Blinding is partial: the layer leaves visible traces, so the scorer can
  often tell the arm. The primary metric is scored mechanically against the
  sealed key wherever the defect is planted, which limits room for judgement.

## 7. Analysis and decision rule

Primary estimand: the difference B − A0 in M1, averaged over held-out tasks,
with a 95 % task-level cluster-bootstrap interval. B − A1 is reported the same
way.

| Outcome | Condition |
|---|---|
| **Supported** | The whole interval lies beyond −Δ (a reduction of at least Δ), and the M2 and M3 guard rails hold. |
| **Rejected** | The interval excludes a reduction of Δ (no meaningful benefit). |
| **Inconclusive** | Neither of the above. |

Misses, false blocks, bypasses and inconclusive cells are published with the
non-sensitive run records whatever the outcome.

## 8. Not yet fixed

Each item below is **to be fixed with pilot teams before outcomes are seen**,
and recorded here with its reasoning before sealing.

| Item | Value |
|---|---|
| Δ, the minimum reduction in M1 worth adopting | to be fixed with pilot teams before outcomes are seen |
| δ, the tolerated rise in false blocks (M2) | to be fixed with pilot teams before outcomes are seen |
| ρ, the tolerated reviewer-minute ratio (M3) | to be fixed with pilot teams before outcomes are seen |
| N, the number of held-out tasks | to be fixed with pilot teams before outcomes are seen |
| k, repeats per task × arm × agent (design floor: 3) | to be fixed with pilot teams before outcomes are seen |
| Task mix and domains of the held-out set | to be fixed with pilot teams before outcomes are seen |
| M4 questionnaire items and time cap | to be fixed with pilot teams before outcomes are seen |
| Agents and model versions | to be fixed with pilot teams before outcomes are seen |

If the feasible N cannot detect Δ, this file says so before the run, and the
result is then reported as intervals rather than as a verdict.

## 9. Sealing

When section 8 is complete, and before any held-out task exists:

1. Compute the file's hash: `sha256sum PREREGISTRATION.md`.
2. Record that hash in the message of a signed tag on the commit that holds
   the file: `git tag -s prereg-v1 -m "PREREGISTRATION.md sha256 <hash>"`.
3. Obtain an external timestamp for the same hash from a party outside this
   repository (a public registry deposit or an RFC 3161 time-stamping
   authority), and record the receipt's location in the amendment log.

A git timestamp alone is not independent: the repository's author controls it.

## 10. Amendment log

Append-only once sealed. Each entry: date, what changed, why, and the new sha256.

| Date | Change | Reason | sha256 |
|---|---|---|---|
| | (none: not sealed) | | |
