# Benchmark × harness results matrix

This matrix is reconciled against the **registry** (the canonical source of
truth in `registry/commands.py`) and the orchestrator's adapter discovery
(#10193). It is split into two clearly-labeled sections:

1. **Registered benchmarks (44)** — every id declared in `registry/commands.py`.
2. **Adapter-discovered / non-registry (9)** — ids exposed only as orchestrator
   adapters, with no registry entry (`orchestrator.discover_adapters` minus the
   registry). These are runnable but are **not** part of the canonical registry.

## What the cells mean

Cells are **honest about provenance**, not aspirational:

- **A number (e.g. `0.50`)** — a real graded score that was **posted to
  `benchmark_results/latest/` through the orchestrator** during the 2026-05-28
  4-harness certification pass (Cerebras `gpt-oss-120b`). These are the only
  cells backed by a committed, reviewed run. See
  [`CERTIFICATION.md`](CERTIFICATION.md) for the posted set (15 benchmarks).
- **`not-run`** — no real graded `latest/` run for this benchmark/harness is
  committed. (`benchmark_results/**` is gitignored by design — see
  `packages/benchmarks/CLAUDE.md` — so an uncommitted local run does not count
  here.) A previous version of this file printed a flat `1.00` in these cells;
  those were **stale hand-entered calibration values**, not graded results, and
  have been replaced with `not-run` so the table cannot be mistaken for a
  leaderboard.
- **`gated`** — the harness cannot run this benchmark in a keyless/CI
  environment: Docker daemon, real audio/multimodal assets, chain credentials,
  or a live provider key is required. Applies to every harness.

The `smithers` column is intentionally partial: `smithers` is published to
`LATEST_SNAPSHOT_AGENTS` but **not** `CANONICAL_REAL_HARNESSES`, so it is not a
required agent for cross-harness comparability.

**To (re)generate a real number in this table:** run the benchmark through the
orchestrator against a live model, then package + review it:

```bash
python -m benchmarks.orchestrator review \
  --benchmarks <id> --adapters eliza --provider cerebras --model gemma-4-31b \
  --out benchmark_results/review/<id>
```

> **Default eval model:** as of 2026-07-02 the default Cerebras eval model is
> `gemma-4-31b` (131k context, reasoning opt-in), replacing `gpt-oss-120b`.
> The main matrix below is still the last **complete 4-harness** certification
> pass (2026-05-28, `gpt-oss-120b`); a 2026-07-02 single-harness `gemma-4-31b`
> re-baseline is recorded in the addendum after the totals. It is kept separate
> because it does not yet carry the hermes/openclaw/smithers rows the 4-harness
> comparability contract requires.

Only scores that survive `validate-latest-*` + `review-package` should be
transcribed here, and only from `benchmark_results/latest/` — never from
`benchmark_results/baselines/` (the synthetic perfect/wrong/half calibration
harnesses live there and must never leak into this matrix).

---

## Registered benchmarks (44)

`lane` is the CI lane from `orchestrator/ci_coverage.py`
(`scheduled` / `smoke` / `manual`). The four score columns show the posted
value from the 2026-05-28 certification pass where one exists, else `not-run`
or `gated`.

| benchmark | lane | eliza | hermes | openclaw | smithers |
|---|---|---|---|---|---|
| abliteration-robustness | smoke | 1.00 | 1.00 | 1.00 | 1.00 |
| action-calling | scheduled | 1.00 | 1.00 | 1.00 | 1.00 |
| agentbench | scheduled | 1.00 | 1.00 | 1.00 | 1.00 |
| bfcl | scheduled | 0.50 | 0.50 | 0.50 | 0.50 |
| clawbench | smoke | 1.00 | 1.00 | 1.00 | 1.00 |
| configbench | smoke | not-run | not-run | not-run | gated |
| context_bench | scheduled | 1.00 | 1.00 | 1.00 | 1.00 |
| gauntlet | manual | gated | gated | gated | gated |
| gsm8k | smoke | 1.00 | 1.00 | 1.00 | 1.00 |
| hermes_swe_env | manual | gated | gated | gated | gated |
| hermes_tblite | manual | gated | gated | gated | gated |
| hermes_terminalbench_2 | manual | gated | gated | gated | gated |
| hermes_yc_bench | manual | gated | gated | gated | gated |
| humaneval | smoke | 1.00 | 1.00 | 1.00 | 1.00 |
| hyperliquid_bench | scheduled | gated | gated | gated | gated |
| lifeops_bench | scheduled | 1.00 | 1.00 | 1.00 | 1.00 |
| mind2web | smoke | not-run | not-run | not-run | gated |
| mint | scheduled | 1.00 | 1.00 | 1.00 | 1.00 |
| mmau | manual | gated | gated | gated | gated |
| mmlu | smoke | 1.00 | 1.00 | 1.00 | 1.00 |
| mt_bench | smoke | not-run | not-run | not-run | gated |
| openclaw_bench | smoke | not-run | not-run | not-run | gated |
| orchestrator_lifecycle | smoke | not-run | not-run | not-run | gated |
| osworld | manual | gated | gated | gated | gated |
| realm | smoke | 1.00 | 1.00 | 1.00 | 1.00 |
| recall_bench | smoke | not-run | not-run | not-run | gated |
| rlm_bench | smoke | not-run | not-run | not-run | gated |
| scambench | smoke | 1.00 | 1.00 | 1.00 | 1.00 |
| social_alpha | smoke | not-run | not-run | not-run | gated |
| solana | manual | gated | gated | gated | gated |
| swe_bench | manual | gated | gated | gated | gated |
| swe_bench_orchestrated | manual | gated | gated | gated | gated |
| tau_bench | scheduled | 1.00 | 1.00 | 1.00 | 1.00 |
| terminal_bench | manual | gated | gated | gated | gated |
| trajectory_replay | smoke | not-run | not-run | not-run | gated |
| trust | smoke | not-run | not-run | not-run | gated |
| vending_bench | manual | gated | gated | gated | gated |
| vision_language | smoke | gated | gated | gated | gated |
| visualwebbench | smoke | not-run | not-run | not-run | gated |
| voiceagentbench | manual | gated | gated | gated | gated |
| voicebench | manual | gated | gated | gated | gated |
| voicebench_quality | manual | gated | gated | gated | gated |
| webshop | smoke | not-run | not-run | not-run | gated |
| woobench | smoke | 0.89 | 0.89 | 0.93 | 0.91 |

**Registered totals:** 44 benchmarks. 15 have a real posted score (from the
2026-05-28 certification pass, `benchmark_results/latest/`); the rest are
`not-run` (no committed graded run) or `gated` (infra/credentials required).

---

## 2026-07-02 addendum — `gemma-4-31b` eliza-harness re-baseline

A fresh reviewed run of the confirmed bridge-wired eliza-harness core on the
new default eval model **`gemma-4-31b`** (Cerebras). These are real graded
`benchmark_results/latest/` runs, hand-reviewed
(`.github/issue-evidence/10199-gemma-4-31b-cutover/review-package/`), all
`status: succeeded`. They are recorded here rather than overwriting the main
matrix because that matrix is a **4-harness** cert and this pass is
eliza-only (+ `mmlu` on hermes/openclaw) — the review-package gate stays
`blocked` on multi-harness comparability, which needs the external hermes /
openclaw agent stacks (infra-gated successor scope, #10199 / #10193).

| benchmark | eliza (gemma-4-31b) | samples | note |
|---|---|---|---|
| mmlu | 0.70 | 40 | also hermes 0.75, openclaw 0.75 |
| gsm8k | 0.975 | 40 | strict `#### <int>` |
| humaneval | 0.75 | 20 | 0.35 → 0.75 after a reply-flattening fix (#10199) |
| mt_bench | 0.90 | 8 | gemma-4-31b judge |
| bfcl | 0.86 | multiple+parallel, 25/cat | |
| action-calling | 1.00 | 20 | |
| agentbench | 0.00 | OS, 5 tasks, no_docker | real completed run; genuine hard-task perf |
| tau_bench | 0.00 | retail, 5 tasks | real completed run; genuine hard-task perf |
| mint | 1.00 | reasoning, 5 tasks | |
| context_bench | 0.75 | 1k/8k, middle | |

---

## Adapter-discovered / non-registry (9)

These ids are exposed by `orchestrator.discover_adapters` but have **no entry
in `registry/commands.py`**. They are not part of the canonical 44 and have no
committed graded `latest/` run — they are shown for completeness only.

| benchmark | lane | eliza | hermes | openclaw | smithers |
|---|---|---|---|---|---|
| adhdbench | smoke | not-run | not-run | not-run | gated |
| app-eval | smoke | not-run | not-run | not-run | gated |
| eliza_1 | smoke | not-run | not-run | not-run | gated |
| eliza_replay | smoke | not-run | not-run | not-run | gated |
| experience | smoke | not-run | not-run | not-run | gated |
| framework | smoke | not-run | not-run | not-run | gated |
| interrupt_bench | smoke | not-run | not-run | not-run | gated |
| personality_bench | smoke | not-run | not-run | not-run | gated |
| three_agent_dialogue | smoke | not-run | not-run | not-run | gated |

---

## Reconciliation notes (#10193)

The previous version of this file listed **53 rows** and drifted from the
registry in three ways, all fixed here:

- **Omitted 2 registered ids** — `recall_bench` and `trajectory_replay` were
  missing. Both are now present in the registered section.
- **Included 3 phantom ids** that are neither registry entries nor orchestrator
  adapters — `compactbench`, `evm`, `loca_bench` (deleted in the #9475 de-larp
  pass; see `README.md`). They have been dropped.
- **Conflated 11 non-registry ids into the main table.** The 9 that still exist
  as adapters (`adhdbench`, `app-eval`, `eliza_1`, `eliza_replay`, `experience`,
  `framework`, `interrupt_bench`, `personality_bench`, `three_agent_dialogue`)
  are quarantined into the clearly-labeled non-registry section above; the other
  2 (`compactbench`, `loca_bench`) were part of the phantom set removed.

The registered set (44), the non-registry adapter set (9), the lane cells, and
the certified numeric rows here are kept in sync by
`tests/test_results_matrix_sync.py`; the CI lane taxonomy itself is pinned by
`tests/test_ci_coverage.py`.
