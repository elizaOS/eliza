# #12781 — LifeOps optimization before/after benchmark closeout evidence

Closeout evidence for the LifeOps optimization pass (#12284 split): live-model
before/after benchmark comparison across the D1/D2/D3 runtime changes, with the
deterministic timeliness gate and the F1 neurotypical-control canary.
Tracking issues: #12781 (spec) and #13354 (remaining-work tracker).

## Commits compared

| side | commit | meaning |
|---|---|---|
| before | `9ab1e596a301bf87f95c7607160fac484e3b22b9` | parent of the EARLIEST D1-D3 child-PR merge (#13211, merged 2026-07-04T13:59Z); pre-dates #13211, #13221, #13233, #13235, #13237, #13284 |
| after | `08b5e87ff` (develop tip at run time) | includes all six runtime child PRs + all 8 scenario packs #12769–#12776 |

ALL after-side runs in this directory (timeliness gate, prompt benchmark,
LifeOpsBench) executed in the same checkout at `08b5e87ff` (verified via the
lane reflog: the branch was checked out at 14:32 EDT and did not move; every
run started later that afternoon). The coordinator's earlier independent
timeliness-gate green the same day was at `61de97785c` — a nearby ancestor —
which this run confirms at tip.

Both sides list the identical 398-case prompt-benchmark inventory
(3 suites x 10 persona variants) and resolve the identical 15378-scenario
lifeops-bench corpus, so the comparisons are apples-to-apples.

## Provider / model (recorded per PR_EVIDENCE.md)

- Provider: Cerebras (`--provider cerebras`), base URL `https://api.cerebras.ai/v1`
- Model: `gemma-4-31b` — repo default `DEFAULT_CEREBRAS_TEXT_MODEL`
  (`packages/core/src/contracts/service-routing.ts`); no `CEREBRAS_MODEL`
  override set. LifeOpsBench result filenames record the same model id.
- No proxy, no mock judge, no `SCENARIO_USE_LLM_PROXY`. Live model both sides.

## Headline results

- **Timeliness gate: GREEN both sides** (1 file / 1 test passed, EXIT=0).
- **Prompt benchmark: FLAT within single-run noise.** accuracy 23.4% -> 22.6%
  (93 -> 90 of 398, -0.8pp), weighted 29.5% -> 28.9% (-0.6pp), null-case
  false-positive rate identical at 6.25%. reminder_dispatch (the task adjacent
  to the D1-D3 changes) 19.0% -> 19.8%. Case-level movement is dominated by
  symmetric harness trajectory-capture dropouts (see NOTES.md).
- **LifeOpsBench static: zero movement.** All 10 per-domain mean scores
  identical before/after; **F1 neurotypical canary (8 control scenarios): NO
  REGRESSION** (every per-scenario score identical).

## Files

| file | what |
|---|---|
| `prompt-benchmark-after.{json.gz,md,ax.jsonl.gz}` | full 398-case live run at the after-SHA (raw report + markdown summary + per-case trajectories) |
| `before/prompt-benchmark-before.{json.gz,md,ax.jsonl.gz}` | full 398-case live run at the before-SHA |
| `prompt-benchmark-cases-{before,after}.csv` | per-case pass/fail, actions, weight, llmCallCount, latency, cost — recomputes every delta table without unpacking the raw JSON |
| `prompt-benchmark-deltas.md` | overall / by-suite / by-task / by-riskClass / by-variant deltas + case-level movement |
| `timeliness-gate-before.txt` / `timeliness-gate-after.txt` | deterministic DST timeliness gate (TZ=UTC, keyless) at each SHA |
| `lifeops-bench-before/` / `lifeops-bench-after/` | LifeOpsBench eliza-agent static runs (core suite + 8 F1 controls) incl. harness logs, all exits 0 |
| `lifeops-bench-deltas.md` | per-domain + per-control-scenario deltas + F1 canary verdict |
| `NOTES.md` | exact commands, environment findings, trajectory spot-read notes, honest N/A rows |
