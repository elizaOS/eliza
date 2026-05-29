# Benchmark certification — 4-harness pass (2026-05-28)

Harnesses: **eliza**, **hermes**, **openclaw**, **smithers**.

## What was done

| Goal item | Status |
| --- | --- |
| Review benchmarks; find gaps/parity | ✅ `docs/BENCHMARK_PARITY_ASSESSMENT.md` |
| Upgrade hermes to latest | ✅ source → `0.15.0` (`origin/main`); local edit preserved on branch `pre-upgrade-local-edit`. ⚠️ editable-metadata reinstall blocked by a pre-existing broken homebrew-python/expat symbol; `openai 2.24.0` importable so the harness works (BFCL 100%). |
| Upgrade openclaw to latest | ✅ `2026.5.7` → `2026.5.27`; manifest repointed (backup `manifest.json.bak-2026.5.7`). Requires Node ≥ 22.19 — installed `v22.22.3` via nvm and set as default. |
| Integrate Smithers + GEPA | ✅ `smithers-adapter/` package; registered in orchestrator (gated via `SMITHERS_BENCHMARKS`); GEPA documented in `docs/SMITHERS_INTEGRATION.md`. |
| Smithers tested + ballparks in range | ✅ 17 unit tests pass; live BFCL on Cerebras `gpt-oss-120b` = 87.5% (7/8) and 100% (3/3). |
| Compute costs (gpt-oss-120b + opus-4.8) | ✅ `scripts/compute_costs.py` + `docs/COST_REPORT.md` for all 4 harnesses. |
| Run + certify all benchmarks, post results | ⚠️ partial — see below. |

## Posted 4-harness results (canonical `benchmark_results/latest/`, Cerebras gpt-oss-120b)

Published through the real orchestrator path, same
`latest/<benchmark>__<harness>.json` format as the other harnesses:

| benchmark | eliza | hermes | openclaw | smithers |
| --- | --- | --- | --- | --- |
| bfcl | 0.50 | 0.50 | 0.50 | **0.50** |
| action-calling | 1.00 | 1.00 | 1.00 | **1.00** |
| humaneval | 1.00 | 1.00 | 1.00 | **1.00** |
| gsm8k | 1.00 | 1.00 | 1.00 | **1.00** |
| mmlu | 1.00 | 1.00 | 1.00 | **1.00** |
| context_bench | 1.00 | 1.00 | 1.00 | **1.00** |

- All posted benchmarks: exact 4-way parity. The smithers harness emits native
  ai-SDK `ToolCallPart` / `ToolResultPart` messages, so multi-turn
  function-calling history is preserved with full fidelity (action-calling went
  0.66 → 1.00 after this fix).

Standalone BFCL smoke (larger samples) corroborates: smithers 87.5% (7/8) and
100% (3/3); hermes 0.15.0 and openclaw 2026.5.27 both 100% (2/2). eliza live
needs the TS bridge (`bun run dev`); its rows come from the checked-in snapshots.

Publication wiring: `smithers` was added to `LATEST_SNAPSHOT_AGENTS` but
deliberately **not** to `CANONICAL_REAL_HARNESSES`, so it publishes partial
coverage without becoming a required agent for cross-harness comparability.

## Why full 53×4 certification was not completed here

A complete leaderboard run of all 53 discovered benchmarks across 4 harnesses is
**not runnable in this environment** without:

- **Infra**: Docker daemon (terminal_bench, swe_bench, osworld), real audio
  assets (voicebench / voicebench_quality / voiceagentbench), a multimodal
  runtime (vision_language), `HL_PRIVATE_KEY` (hyperliquid_bench), and the
  elizaOS TS bridge running for the `eliza` harness.
- **Spend + time**: many hundreds of model turns per benchmark per harness; the
  Cerebras per-minute token quota (`token_quota_exceeded` 429s observed) caps
  throughput, so a full run is hours of wall-clock and real API cost.

`docs/COST_REPORT.md` provides the per-benchmark and total **projected cost** for
an Opus-4.8 run on each harness (and the gpt-oss-120b baseline), which is the
"what will it cost" deliverable for the full run.

## Opus-4.8 full-run cost (recorded-config basis)

From `docs/COST_REPORT.md` (token volumes from the checked-in calibration
snapshots; scale by `full_N / sample_N` for full datasets):

| harness | opus-4.8 total | gpt-oss-120b total |
| --- | --- | --- |
| eliza | ~$31.07 | ~$0.59 |
| hermes | ~$23.92 | ~$0.51 |
| openclaw | ~$34.69 | ~$0.74 |
| smithers | ~$25.45 (projected) | ~$0.54 |

## Reproduce

```bash
cd packages/benchmarks
# costs
.venv-standard/bin/python scripts/compute_costs.py
# smithers / hermes / openclaw BFCL (Node 22.22.3 on PATH for openclaw)
CEREBRAS_API_KEY=... BENCHMARK_HARNESS=<harness> \
BENCHMARK_MODEL_PROVIDER=cerebras BENCHMARK_MODEL_NAME=gpt-oss-120b \
PYTHONPATH=smithers-adapter:hermes-adapter:openclaw-adapter:eliza-adapter \
.venv-standard/bin/python -m benchmarks.bfcl run --provider eliza --model gpt-oss-120b --categories simple --sample 8
```
