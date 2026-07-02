# Benchmark Review Scorecard

- status: `ok`
- git SHA: `f6837a4678f4df676c6c782141e7306fdd4bf65b`
- generated at: `2026-07-02T18:13:34Z`
- latest dir: `/home/shaw/eliza-wt-gemma4b/packages/benchmarks/benchmark_results/latest`
- reviewed by: `gemma-4-31b closeout (#10199/#10193)`
- latest rows: `12`
- readiness findings: `0`
- artifact offenders: `0`

## Reviewer Note

Multi-harness comparability revalidation on gemma-4-31b (Cerebras). eliza+hermes+openclaw run with identical extra_config so comparison signatures match; opened per-harness result JSON + trajectories and spot-checked. mmlu/gsm8k/bfcl/action-calling comparable within 0.08. humaneval excluded: eliza AgentRuntime Stage-1 reply heuristic (isUnusableStage1Reply, message.ts) defers ~60% of code turns to 'I'm not sure how to answer that.', so eliza(0.4) vs raw-model hermes/openclaw(1.0) is a runtime-pipeline gap not a model/harness-availability gap.

## Gate Summary

| gate | status | detail |
| --- | --- | --- |
| inventory | `ok` | gaps=0 |
| latest readiness | `ok` | findings=0 |
| artifact guard | `ok` | offenders=0 |

## Latest Rows

| benchmark | agent | status | score | provider | model | run id | trajectory dir |
| --- | --- | --- | --- | --- | --- | --- | --- |
| action-calling | eliza | succeeded | 1.0 | cerebras | gemma-4-31b | run_action-calling_20260702T180407Z_1_93142f6e |  |
| action-calling | hermes | succeeded | 1.0 | cerebras | gemma-4-31b | run_action-calling_20260702T181244Z_3_be45d9e6 |  |
| action-calling | openclaw | succeeded | 1.0 | cerebras | gemma-4-31b | run_action-calling_20260702T180745Z_1_288e81b1 |  |
| bfcl | eliza | succeeded | 1.0 | cerebras | gemma-4-31b | run_bfcl_20260702T180353Z_1_fce181ea |  |
| bfcl | hermes | succeeded | 1.0 | cerebras | gemma-4-31b | run_bfcl_20260702T180502Z_1_d87fe382 |  |
| bfcl | openclaw | succeeded | 1.0 | cerebras | gemma-4-31b | run_bfcl_20260702T180742Z_1_4e124b71 |  |
| gsm8k | eliza | succeeded | 0.95 | cerebras | gemma-4-31b | run_gsm8k_20260702T180241Z_1_178a2046 |  |
| gsm8k | hermes | succeeded | 0.975 | cerebras | gemma-4-31b | run_gsm8k_20260702T180436Z_1_c5204f88 |  |
| gsm8k | openclaw | succeeded | 0.975 | cerebras | gemma-4-31b | run_gsm8k_20260702T180716Z_1_571277e3 |  |
| mmlu | eliza | succeeded | 0.725 | cerebras | gemma-4-31b | run_mmlu_20260702T180205Z_1_12aaa015 |  |
| mmlu | hermes | succeeded | 0.8 | cerebras | gemma-4-31b | run_mmlu_20260702T180423Z_1_ad8fbd08 |  |
| mmlu | openclaw | succeeded | 0.8 | cerebras | gemma-4-31b | run_mmlu_20260702T180706Z_1_7e00c5a0 |  |
