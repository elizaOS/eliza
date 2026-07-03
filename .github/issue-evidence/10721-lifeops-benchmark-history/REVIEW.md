# #11789 — Real-model LifeOps/PA prompt-benchmark baseline (score history)

**Model under test:** `gpt-oss-120b` via Cerebras. Selected with the harness's
own live-provider selector (`--provider cerebras` /
`selectLiveProvider("cerebras")`), driven by `CEREBRAS_API_KEY` +
`OPENAI_BASE_URL=https://api.cerebras.ai/v1`. No proxy, no mock judge.

**Harness:** the shipped LifeOps prompt benchmark
(`plugins/plugin-personal-assistant/test/helpers/lifeops-prompt-benchmark-runner.ts`,
CLI at `scripts/lifeops-prompt-benchmark.ts`). The `direct` variant slice
covering all optimization tasks was run (`LIFEOPS_PROMPT_BENCHMARK_LIVE=1`,
case limit 10). The full catalog is 398 cases across 3 suites x 10 variants —
this baseline is the task-covering `direct` slice.

## Baseline score (this run)

| metric | value |
| --- | --- |
| provider | **cerebras** |
| accuracy | **70.0% (7/10)** |
| null-case false-positive rate | 0.0% |
| trajectory capture | 100.0% |
| latency | avg 4409ms · p50 4309ms · p95 7199ms |

Per task: calendar_extract 1/1, health_checkin 1/1, inbox_triage 1/1,
meeting_prep 1/1, morning_brief 1/1, schedule_plan 1/1, screentime_recap 1/1,
**reminder_dispatch 0/3** (the sole failing task at this model tier).

**Files:** `baseline-selfcare-direct-cerebras.json` (machine-readable report),
`.md` (formatted score card), `.jsonl` (Ax optimization rows),
`benchmark-live-cerebras-run.log` (vitest live-gate run log),
`cerebras-endpoint-proof.txt` (independent endpoint liveness check).

## Open human decision (blocks final #11789 closure)

The one remaining human-gated item is **the durable retention/reporting
location for score history**. This commit establishes the baseline artifact
format under `.github/issue-evidence/`, but a maintainer must decide where the
recurring series lives (e.g. a nightly CI lane publishing to a dedicated
`benchmark-history/` path, a dashboard, or a pinned artifact bucket) so the
trend — not just this single point — is reviewer-visible over time. Credentials
(Cerebras) are confirmed working here; only the retention decision + the
scheduled lane wiring remain for a human.
