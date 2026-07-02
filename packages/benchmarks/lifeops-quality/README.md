# lifeops-quality — recorded-baseline LifeOps benchmarks (#10723)

Two keyless, deterministic quality benchmarks over **real** LifeOps code
paths, with committed baselines and ratchet-style regression gates
(mirrors `packages/benchmarks/recall-bench`).

## Lanes

| Lane | Code under test | Corpus | Gate |
| --- | --- | --- | --- |
| **triage** | `plugins/plugin-inbox/src/inbox/triage-classifier.ts` — `classifyMessages`'s prompt-build → parse → validate → fail-closed path | 56 labeled inbox items (`triage/corpus.ts`) + a committed fixed-quality mock model (`triage/fixtures.ts`, 7 deliberate errors) | per-class precision/recall + accuracy + macro-F1 floors (`budgets.json`), plus an EXACT match against `baseline.json` (the pipeline is fully deterministic) |
| **timeliness** | `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.ts` — `processDueScheduledTasks` on a real PGlite runtime with an injected clock | two 4-day 2026 DST windows (spring-forward + fall-back), 5-minute cadence, cron/once/interval across NY/Berlin/Kolkata/Sydney/UTC (`timeliness/corpus.ts`) | missed/duplicate/early/occurrence-mismatch fire counts must be **exactly 0**; max/mean fire-time deviation under `budgets.json` ceilings |

The mock model in the triage lane simulates a model of *fixed* quality — the
benchmark measures the classifier pipeline, not production model quality.
Each batch's response rotates through every parse envelope the classifier
accepts (plain object, fenced legacy array, `<think>`-prefixed, column
format, alias keys), so a regression in any accepted shape shows up as
missing/failed rows.

The timeliness oracle (`timeliness/oracle.ts`) never calls the production
cron walker: `once`/`cron` expectations are hand-authored UTC instants
(cross-checked against Intl tzdata by the unit lane), and `interval`
expectations derive from the re-anchor-on-fire contract.

## Commands

```bash
bun run test              # unit lane: metrics, oracle, corpus/fixture/baseline invariants (fast, no DB)
bun run bench             # both gates (real classifier + real scheduler tick over PGlite)
bun run bench:triage      # triage gate only (~10s)
bun run bench:timeliness  # timeliness gate only (~3min, ~2,300 real ticks)
```

Measured runs land in `results/*.json` (gitignored; uploaded as a CI
artifact). CI: `.github/workflows/lifeops-quality-bench.yml` — keyless,
runs on PRs touching the corpus, the classifier, the scheduled-task spine,
or core trigger scheduling, plus nightly.

## Editing the corpus, fixtures, budgets, or baseline

- **Corpus/fixtures changed?** Re-record `baseline.json` in the same change:
  run the gates, copy the measured blocks from `results/*.json`. The unit
  lane cross-checks `baseline.json` against both the corpus×fixtures score
  and `budgets.json`, so a stale baseline fails fast.
- **Budgets** are calibrated so ONE additional triage misclassification (or
  any scheduler fire defect) trips the gate — `triage/corpus.test.ts` proves
  this calibration. When a run beats a floor with headroom the gate prints a
  ratchet prompt; tighten `budgets.json` rather than letting headroom rot.
- The timeliness `maxDeviationMs` ceiling **is** the tick cadence (300000ms)
  — do not loosen it; a larger ceiling would tolerate a real lateness bug.
- The fall-back window deliberately has no cron inside the repeated
  01:00–01:59 hour: core's ambiguous-hour behavior is pinned separately and
  must not be baked into this gate's expectations.
