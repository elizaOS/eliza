# Code Agent Matrix Summary

Generated: 2026-07-02T20:43:56.700987+00:00
Cells: 2

## Run Config

Mode: dry_run
Provider/model: cerebras/gemma-4-31b
Benchmarks: swe_bench, terminal_bench
Adapters: elizaos
Max tasks: 1
Timeout seconds: 3600
SWE-bench Pro evaluator backend:
SWE-bench Pro eval workers:
Enforce comparable: False
Enforce coverage: False
Enforce token evidence: False
Enforce required stats: False
Enforce efficiency: False
Enforce no regression: False
Enforce quality guardrail: False
Enforce trajectory reviews: False
Enforce live report: False
Enforce report: False
Enforce release readiness: False

## Run Result

Exit code: 0
Exit reason: ok

## Exit Codes

| code | name | meaning |
| --- | --- | --- |
| 0 | ok | run completed without an enforced gate failure |
| 2 | preflight_failed | preflight checks failed |
| 3 | comparable_gate_failed | ElizaOS was not comparable-or-better than OpenCode on every selected benchmark |
| 4 | token_evidence_failed | one or more selected cells lacked usable LLM token telemetry |
| 5 | required_stats_failed | one or more selected benchmarks lacked required outcome or token stats |
| 6 | coverage_gate_failed | the run did not cover every included code-agent benchmark |
| 7 | report_gate_failed | the combined release-readiness report gate failed |
| 8 | efficiency_gate_failed | ElizaOS used more tokens, made more LLM calls, or had lower cached-token percentage than OpenCode |
| 9 | no_regression_failed | ElizaOS regressed against the previous comparison summary |
| 10 | quality_guardrail_failed | the broader non-code benchmark readiness guardrail failed |
| 11 | trajectory_review_failed | one or more selected cells lacked reviewable trajectory telemetry |
| 12 | live_report_failed | the report was not generated from live benchmark execution |
| 13 | release_readiness_failed | the final release-readiness checklist failed |

## Preflight

Status: ok
Provider: cerebras
Provider key: CEREBRAS_API_KEY (missing, not required)
Quality guardrail summary: missing (missing, not required, not checked)
OpenCode: /home/shaw/eliza-worktrees/11346-bench-readiness/plugins/plugin-agent-orchestrator/bin/opencode

## Report Gate

Status: blocked
Message: benchmark report is not yet release-ready
Blocking gates: benchmark coverage, comparable-or-better outcomes, required stats

## Release Readiness

Status: blocked
Message: release readiness checklist is incomplete
Required checks: 1/9
Blocking requirements: live_execution, full_included_coverage, all_related_benchmark_coverage, comparable_or_better, right_wrong_token_stats, llm_token_telemetry, trajectory_reviews, non_code_quality_guardrail

| id | required | ok | evidence | next action |
| --- | --- | --- | --- | --- |
| live_execution | True | False | report was not generated from live benchmark execution | run without --smoke/--dry-run and enforce --enforce-live-report |
| full_included_coverage | True | False | not all included code-agent benchmarks are selected | select every included code-agent benchmark |
| all_related_benchmark_coverage | True | False | deferred related benchmarks remain: vision_language | promote deferred related benchmarks into the release-comparable matrix |
| comparable_or_better | True | False | elizaos is not yet comparable-or-better on all selected benchmarks | review improvement_queue and improve ElizaOS on blocking benchmarks |
| right_wrong_token_stats | True | False | required benchmark stats are incomplete for this run mode | rerun blocking cells until right/wrong/total and token stats are present |
| llm_token_telemetry | True | False | some cells did not produce usable LLM token telemetry | enable trajectory/token capture for every selected cell |
| trajectory_reviews | True | False | some selected cells lack reviewable trajectory telemetry | run with --enforce-trajectory-reviews and inspect trajectory artifacts |
| efficiency_not_worse | True | True | ElizaOS has no token, LLM-call, or cached-token regressions versus OpenCode | reduce extra token/call cost or improve cache behavior versus OpenCode |
| non_code_quality_guardrail | True | False | quality guardrail is advisory without a summary | generate non-code guardrail JSON with `PYTHONPATH=packages python -m benchmarks.orchestrator validate-latest-readiness --skip-runtime-gates --exclude-benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,vision_language,visualwebbench,webshop --json > /path/to/non-code-quality-guardrail.json` and pass it with --quality-guardrail-summary |
| longitudinal_no_regression | False | True | no-regression gate is advisory without a previous summary | compare against the previous summary with --compare-summary |

### Release Unblock Commands

| id | requirements | command |
| --- | --- | --- |
| run_full_live_evidence | comparable_or_better, full_included_coverage, live_execution, llm_token_telemetry, right_wrong_token_stats, trajectory_reviews | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-coverage --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency --enforce-release-readiness` |
| run_deferred_live_evidence | all_related_benchmark_coverage | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks vision_language --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency` |
| promote_deferred_benchmarks | all_related_benchmark_coverage | `python -m benchmarks.orchestrator.code_agent_matrix --summarize {summary_json}` |
| attach_non_code_quality_guardrail | non_code_quality_guardrail | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --force --quality-guardrail-summary /path/to/non-code-quality-guardrail.json --enforce-quality-guardrail --enforce-report --enforce-release-readiness` |

## Next Commands

### Retry Preflight

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks swe_bench,terminal_bench --adapters elizaos --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --preflight --no-docker
```

### Live Evidence

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks swe_bench,terminal_bench --adapters elizaos --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-coverage --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency --enforce-release-readiness --no-docker
```

### Deferred Live Evidence

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks vision_language --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency
```

### Release Preflight

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --quality-guardrail-summary /path/to/non-code-quality-guardrail.json --preflight --enforce-release-readiness
```

### Release Comparable

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-coverage --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency --quality-guardrail-summary /path/to/non-code-quality-guardrail.json --enforce-quality-guardrail --enforce-release-readiness
```


## Efficiency Gate

Status: ok
Enforced: False
Message: ElizaOS has no token, LLM-call, or cached-token regressions versus OpenCode
Blocking benchmarks: (none)

## No Regression Gate

Status: ok
Enforced: False
Message: no-regression gate is advisory without a previous summary
Blocking benchmarks: (none)

## Quality Guardrail Gate

Status: ok
Enforced: False
Summary:
Latest dir:
Message: quality guardrail is advisory without a summary

## Trajectory Review Gate

Status: blocked
Enforced: False
Reviewed cells: 0
Blocking cells: 2
Message: some selected cells lack reviewable trajectory telemetry

| benchmark | adapter | trajectory dir | files | turns | cached % | notes | rerun |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| swe_bench | elizaos | /tmp/claude-1000/eliza-bench-dryrun/swe_bench/elizaos/trajectories | 0 | 0 |  | no trajectory files found, no trajectory turns found, no cached-token telemetry found | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks swe_bench --adapters elizaos --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --smoke --no-docker --force --enforce-trajectory-reviews --enforce-required-stats` |
| terminal_bench | elizaos | /tmp/claude-1000/eliza-bench-dryrun/terminal_bench/elizaos/trajectories | 0 | 0 |  | no trajectory files found, no trajectory turns found, no cached-token telemetry found | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks terminal_bench --adapters elizaos --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --smoke --no-docker --force --enforce-trajectory-reviews --enforce-required-stats` |

## Live Report Gate

Status: blocked
Enforced: False
Mode: dry_run
Message: report was not generated from live benchmark execution

## Benchmark Coverage

Status: partial
Message: some included code-agent benchmarks were not selected for this run
Included selected: 2/10
Deferred: 1
Unselected included benchmarks: mind2web, visualwebbench, webshop, osworld, nl2repo, agentbench, mint, standard_humaneval

### Repo-Local Coverage Audit

Status: ok
Audited directories: 11/11
Message: all audited repo-local related benchmark directories are represented in coverage

| benchmark | domains | selected | reason |
| --- | --- | --- | --- |
| swe_bench | coding | True | Python issue-resolution benchmark with the eliza adapter bridge. |
| terminal_bench | terminal, coding | True | Terminal task benchmark with task-agent adapter selection. |
| mind2web | browser, web | False | Browser interaction benchmark routed through the eliza bridge. |
| visualwebbench | browser, vision | False | Visual browser benchmark routed through the eliza bridge. |
| webshop | browser, web | False | Shopping-agent browser benchmark with bridge-backed agent calls. |
| osworld | computer-use, desktop | False | Desktop computer-use benchmark via the OSWorld eliza bridge. |
| nl2repo | coding | False | Natural-language-to-repository coding benchmark with built-in ElizaOS/OpenCode agent command wiring, trajectory/token capture, and Docker-backed live scoring. |
| agentbench | terminal, browser, web, computer-use | False | AgentBench OS, WebShop, and Mind2Web-related fixture tasks run through the ElizaOS/OpenCode bridge with deterministic environment scoring, right/wrong totals, and trajectory/token telemetry. |
| mint | coding, tool-use | False | MINT HumanEval/MBPP coding subtasks run through the ElizaOS/OpenCode agent bridge with the benchmark's multi-turn tool/feedback loop, turn-k scoring, right/wrong totals, and trajectory/token telemetry. |
| standard_humaneval | coding | False | HumanEval is wrapped as a code-agent function-body task with ElizaOS/OpenCode agent command execution, sandboxed pass/fail scoring, and trajectory/token telemetry. |

### Deferred Related Benchmarks

| priority | benchmark | domains | reason | promotion requirements |
| --- | --- | --- | --- | --- |
| p1 | vision_language | computer-use, browser, vision | The eliza-1 vision-CUA harness exercises real screen capture, VLM grounding, OCR, and plugin-computeruse clicks, and the vision-language runner now exposes ElizaOS/OpenCode harness labels, but it still needs non-stub matched-driver runs before release-comparable inclusion. | validate non-stub ElizaOS and OpenCode runs through the vision-language harness labels; require real eliza-1/VLM input bundles and non-stub desktop capture; normalize grounding/click verification into right/wrong/total plus token and LLM-call telemetry |

## Deferred Promotion Queue

| priority | benchmark | domains | next action | remaining | evidence command |
| --- | --- | --- | --- | ---: | --- |
| p1 | vision_language | computer-use, browser, vision | validate non-stub ElizaOS and OpenCode runs through the vision-language harness labels | 3 | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks vision_language --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency` |

## Coverage Gate

Status: blocked
Message: not all included code-agent benchmarks are selected
Blocking benchmarks: agentbench, mind2web, mint, nl2repo, osworld, standard_humaneval, visualwebbench, webshop

## Benchmark Gate

Status: blocked
Message: elizaos is not yet comparable-or-better on all selected benchmarks
Blocking benchmarks: swe_bench, terminal_bench

## Required Stats Gate

Status: blocked
Message: required benchmark stats are incomplete for this run mode
Token evidence required: False
Blocking requirements: outcome_right_wrong_totals

| benchmark | outcome status | target accuracy | baseline accuracy | target total | baseline total | rerun |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| swe_bench | missing |  |  |  |  | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks swe_bench --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --smoke --no-docker --force --enforce-required-stats` |
| terminal_bench | missing |  |  |  |  | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks terminal_bench --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --smoke --no-docker --force --enforce-required-stats` |

## Cells

| benchmark | adapter | status | score | right | wrong | total | cached % | input tokens | output tokens | LLM calls | failure_class | result |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| swe_bench | elizaos | dry_run |  |  |  |  |  | 0 | 0 | 0 | stopped_early |  |
| terminal_bench | elizaos | dry_run |  |  |  |  |  | 0 | 0 | 0 | stopped_early |  |

## ElizaOS vs OpenCode

| benchmark | status | target accuracy | baseline accuracy | accuracy delta | target right/wrong | baseline right/wrong | target input | baseline input | target output | baseline output | target total tokens | baseline total tokens | total token delta | target cached % | baseline cached % | cached % delta | target LLM calls | baseline LLM calls | LLM call delta |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| swe_bench | missing |  |  |  | / | / | 0 |  | 0 |  | 0 |  |  |  |  |  | 0 |  |  |
| terminal_bench | missing |  |  |  | / | / | 0 |  | 0 |  | 0 |  |  |  |  |  | 0 |  |  |

## Token Totals By Adapter

| adapter | input | output | total | cached | cached % | LLM calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| elizaos | 0 | 0 | 0 | 0 |  | 0 |

## Token Evidence

Status: incomplete
Message: some cells did not produce usable LLM token telemetry

| benchmark | adapter | evidence | LLM calls | input | output | total | cached % | note |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| swe_bench | elizaos | missing | 0 | 0 | 0 | 0 |  | no trajectory artifacts or token usage found |
| terminal_bench | elizaos | missing | 0 | 0 | 0 | 0 |  | no trajectory artifacts or token usage found |

## Improvement Queue

| priority | benchmark | status | diagnosis | focus | next action | accuracy delta | target failure | baseline failure | target trajectories | baseline trajectories |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| p1 | swe_bench | missing | missing comparable outcome evidence | fix target harness/runtime failure before tuning prompts, restore trajectory capture for comparable review evidence | run live benchmark cell until both adapters have comparable outcome metrics |  | stopped_early |  | /tmp/claude-1000/eliza-bench-dryrun/swe_bench/elizaos/trajectories |  |
| p1 | terminal_bench | missing | missing comparable outcome evidence | fix target harness/runtime failure before tuning prompts, restore trajectory capture for comparable review evidence | run live benchmark cell until both adapters have comparable outcome metrics |  | stopped_early |  | /tmp/claude-1000/eliza-bench-dryrun/terminal_bench/elizaos/trajectories |  |

### Queue Rerun Commands

```bash
python -m benchmarks.orchestrator.code_agent_matrix --rerun-queue {summary_json} --queue-priorities p1 --queue-statuses missing --compare-summary {summary_json} --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /tmp/claude-1000/eliza-bench-dryrun --smoke --no-docker --force
```


### Trajectory Review Briefs

| benchmark | adapter | files | turns | input | output | cached % | repeated prefixes | notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| swe_bench | target | 0 | 0 | 0 | 0 |  | 0 | no trajectory files found, no trajectory turns found, no cached-token telemetry found |
| swe_bench | baseline | 0 | 0 | 0 | 0 |  | 0 | no trajectory directory recorded |
| terminal_bench | target | 0 | 0 | 0 | 0 |  | 0 | no trajectory files found, no trajectory turns found, no cached-token telemetry found |
| terminal_bench | baseline | 0 | 0 | 0 | 0 |  | 0 | no trajectory directory recorded |

### Trajectory Deltas

| benchmark | turn delta | input delta | output delta | total delta | cached % delta | repeated prefix delta | mean latency delta | p95 latency delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| swe_bench | 0 | 0 | 0 | 0 |  | 0 |  |  |
| terminal_bench | 0 | 0 | 0 | 0 |  | 0 |  |  |

## Failure Classes

- `stopped_early`: 2
