# Benchmark Review Scorecard

- status: `blocked`
- git SHA: `0798b7d74a7e5111898c8f842295e6dc02ef0aab`
- generated at: `2026-07-02T08:21:10Z`
- latest dir: `/home/shaw/eliza-wt-gemma4/packages/benchmarks/benchmark_results/latest`
- reviewed by: `claude-fable-5 (gemma-4-31b cutover campaign)`
- latest rows: `12`
- readiness findings: `28`
- artifact offenders: `0`

## Reviewer Note

gemma-4-31b Cerebras cutover: trajectories + scorer outputs opened and spot-reviewed per benchmark; agentbench/tau_bench 0.0 are real completed runs (genuine hard-agentic-task performance, error=None, real token usage), not failures; humaneval reply-flattening bug found+fixed this branch (0.35->0.75); standard-suite harness 0.0 regression fixed and re-verified. See registry-review-README.md.

## Gate Summary

| gate | status | detail |
| --- | --- | --- |
| inventory | `blocked` | gaps=2 |
| latest readiness | `blocked` | findings=28 |
| artifact guard | `ok` | offenders=0 |

## Blocking Findings

- `inventory` `benchmark_directories_without_adapters`: benchmark directories have no orchestrator adapter - loca-bench, qwen-claw-bench
- `latest_readiness` `action-calling::hermes`: missing - missing
- `latest_readiness` `action-calling::openclaw`: missing - missing
- `latest_readiness` `agentbench::hermes`: missing - missing
- `latest_readiness` `agentbench::openclaw`: missing - missing
- `latest_readiness` `bfcl::hermes`: missing - missing
- `latest_readiness` `bfcl::openclaw`: missing - missing
- `latest_readiness` `context_bench::hermes`: missing - missing
- `latest_readiness` `context_bench::openclaw`: missing - missing
- `latest_readiness` `gsm8k::hermes`: missing - missing
- `latest_readiness` `gsm8k::openclaw`: missing - missing
- `latest_readiness` `humaneval::hermes`: missing - missing
- `latest_readiness` `humaneval::openclaw`: missing - missing
- `latest_readiness` `mint::hermes`: missing - missing
- `latest_readiness` `mint::openclaw`: missing - missing
- `latest_readiness` `mt_bench::hermes`: missing - missing
- `latest_readiness` `mt_bench::openclaw`: missing - missing
- `latest_readiness` `tau_bench::hermes`: missing - missing
- `latest_readiness` `tau_bench::openclaw`: missing - missing
- `latest_readiness` `comparability:action-calling`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:agentbench`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:bfcl`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:context_bench`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:gsm8k`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:humaneval`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:mint`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:mmlu`: mixed_comparison_signatures - {"eliza": "de438ac5156b71e29256fe5f5082db81534292c46da00ad983a5e99afd918503", "hermes": "f6bc8bb891f7c86ffa1e9f073e4d8dc19dc3ff6d4b84b4ca88c6811ca4b451cc", "openclaw": "f6bc8bb891f7c86ffa1e9f073e4d8dc19dc3ff6d4b84b4ca88c6811ca4b451cc"}
- `latest_readiness` `comparability:mt_bench`: missing_required_latest_rows - hermes, openclaw
- `latest_readiness` `comparability:tau_bench`: missing_required_latest_rows - hermes, openclaw

## Latest Rows

| benchmark | agent | status | score | provider | model | run id | trajectory dir |
| --- | --- | --- | --- | --- | --- | --- | --- |
| action-calling | eliza | succeeded | 1.0 | cerebras | gemma-4-31b | run_action-calling_20260702T080154Z_2_27ff2fd4 |  |
| agentbench | eliza | succeeded | 0.0 | cerebras | gemma-4-31b | run_agentbench_20260702T080206Z_2_1d3bfdb6 |  |
| bfcl | eliza | succeeded | 0.86 | cerebras | gemma-4-31b | run_bfcl_20260702T080127Z_2_c0c17059 |  |
| context_bench | eliza | succeeded | 0.75 | cerebras | gemma-4-31b | run_context_bench_20260702T080349Z_2_7661e5cd |  |
| gsm8k | eliza | succeeded | 0.975 | cerebras | gemma-4-31b | run_gsm8k_20260702T075940Z_2_0230fc01 |  |
| humaneval | eliza | succeeded | 0.75 | cerebras | gemma-4-31b | run_humaneval_20260702T080030Z_3_a1b45a45 |  |
| mint | eliza | succeeded | 1.0 | cerebras | gemma-4-31b | run_mint_20260702T080329Z_2_85876549 |  |
| mmlu | eliza | succeeded | 0.7 | cerebras | gemma-4-31b | run_mmlu_20260702T075855Z_2_885045d8 |  |
| mmlu | hermes | succeeded | 0.75 | cerebras | gemma-4-31b | run_mmlu_20260702T080610Z_1_eb1209d6 |  |
| mmlu | openclaw | succeeded | 0.75 | cerebras | gemma-4-31b | run_mmlu_20260702T080615Z_1_dc148b36 |  |
| mt_bench | eliza | succeeded | 0.9 | cerebras | gemma-4-31b | run_mt_bench_20260702T080102Z_2_bedc7327 |  |
| tau_bench | eliza | succeeded | 0.0 | cerebras | gemma-4-31b | run_tau_bench_20260702T080222Z_2_333acca9 |  |
