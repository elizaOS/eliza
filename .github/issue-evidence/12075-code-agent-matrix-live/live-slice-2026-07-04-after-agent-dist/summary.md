# Code Agent Matrix Summary

Generated: 2026-07-04T17:37:07.372963+00:00
Cells: 2

## Run Config

Mode: live
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
Provider key: CEREBRAS_API_KEY (present, required)
Quality guardrail summary: missing (missing, not required, not checked)
OpenCode: /private/tmp/eliza-comment-verify/plugins/plugin-agent-orchestrator/bin/opencode

## Report Gate

Status: blocked
Message: benchmark report is not yet release-ready
Blocking gates: benchmark coverage, comparable-or-better outcomes, required stats

## Release Readiness

Status: blocked
Message: release readiness checklist is incomplete
Required checks: 4/9
Blocking requirements: full_included_coverage, all_related_benchmark_coverage, comparable_or_better, right_wrong_token_stats, non_code_quality_guardrail

| id | required | ok | evidence | next action |
| --- | --- | --- | --- | --- |
| live_execution | True | True | report was generated from live benchmark execution | run without --smoke/--dry-run and enforce --enforce-live-report |
| full_included_coverage | True | False | not all included code-agent benchmarks are selected | select every included code-agent benchmark |
| all_related_benchmark_coverage | True | False | deferred related benchmarks remain: vision_language | promote deferred related benchmarks into the release-comparable matrix |
| comparable_or_better | True | False | elizaos is not yet comparable-or-better on all selected benchmarks | review improvement_queue and improve ElizaOS on blocking benchmarks |
| right_wrong_token_stats | True | False | required benchmark stats are incomplete for this run mode | rerun blocking cells until right/wrong/total and token stats are present |
| llm_token_telemetry | True | True | all cells produced LLM token telemetry | enable trajectory/token capture for every selected cell |
| trajectory_reviews | True | True | all selected cells have reviewable trajectory telemetry | run with --enforce-trajectory-reviews and inspect trajectory artifacts |
| efficiency_not_worse | True | True | ElizaOS has no token, LLM-call, or cached-token regressions versus OpenCode | reduce extra token/call cost or improve cache behavior versus OpenCode |
| non_code_quality_guardrail | True | False | quality guardrail is advisory without a summary | generate non-code guardrail JSON with `PYTHONPATH=packages python -m benchmarks.orchestrator validate-latest-readiness --skip-runtime-gates --exclude-benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,vision_language,visualwebbench,webshop --json > /path/to/non-code-quality-guardrail.json` and pass it with --quality-guardrail-summary |
| longitudinal_no_regression | False | True | no-regression gate is advisory without a previous summary | compare against the previous summary with --compare-summary |

### Release Unblock Commands

| id | requirements | command |
| --- | --- | --- |
| run_full_live_evidence | comparable_or_better, full_included_coverage, right_wrong_token_stats | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-coverage --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency --enforce-release-readiness` |
| run_deferred_live_evidence | all_related_benchmark_coverage | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks vision_language --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency` |
| promote_deferred_benchmarks | all_related_benchmark_coverage | `python -m benchmarks.orchestrator.code_agent_matrix --summarize {summary_json}` |
| attach_non_code_quality_guardrail | non_code_quality_guardrail | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --force --quality-guardrail-summary /path/to/non-code-quality-guardrail.json --enforce-quality-guardrail --enforce-report --enforce-release-readiness` |

## Next Commands

### Retry Preflight

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks swe_bench,terminal_bench --adapters elizaos --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --preflight --no-docker
```

### Live Evidence

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks swe_bench,terminal_bench --adapters elizaos --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-coverage --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency --enforce-release-readiness --no-docker
```

### Deferred Live Evidence

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks vision_language --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency
```

### Release Preflight

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --quality-guardrail-summary /path/to/non-code-quality-guardrail.json --preflight --enforce-release-readiness
```

### Release Comparable

```bash
python -m benchmarks.orchestrator.code_agent_matrix --benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,visualwebbench,webshop --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-coverage --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency --quality-guardrail-summary /path/to/non-code-quality-guardrail.json --enforce-quality-guardrail --enforce-release-readiness
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

Status: ok
Enforced: False
Reviewed cells: 2
Blocking cells: 0
Message: all selected cells have reviewable trajectory telemetry

## Live Report Gate

Status: ok
Enforced: False
Mode: live
Message: report was generated from live benchmark execution

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
| p1 | vision_language | computer-use, browser, vision | validate non-stub ElizaOS and OpenCode runs through the vision-language harness labels | 3 | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks vision_language --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --force --enforce-live-report --enforce-trajectory-reviews --enforce-report --enforce-comparable --enforce-required-stats --enforce-token-evidence --enforce-efficiency` |

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
Token evidence required: True
Blocking requirements: outcome_right_wrong_totals

| benchmark | outcome status | target accuracy | baseline accuracy | target total | baseline total | rerun |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| swe_bench | missing | 0.0000 |  | 1 |  | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks swe_bench --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --no-docker --force --enforce-required-stats` |
| terminal_bench | missing | 0.0000 |  | 1 |  | `python -m benchmarks.orchestrator.code_agent_matrix --benchmarks terminal_bench --adapters elizaos,opencode --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --no-docker --force --enforce-required-stats` |

## Cells

| benchmark | adapter | status | score | right | wrong | total | cached % | input tokens | output tokens | LLM calls | failure_class | result |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| swe_bench | elizaos | succeeded | 0.0000 | 0 | 1 | 1 | 0.00 | 11038 | 8192 | 2 | no_patch | /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist/swe_bench/elizaos/output/orchestrated-20260704_172723.json |
| terminal_bench | elizaos | succeeded | 0.0000 | 0 | 1 | 1 | 44.53 | 15235 | 13609 | 20 | tests_failed | /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist/terminal_bench/elizaos/output/terminal-bench-20260704_133701.json |

## ElizaOS vs OpenCode

| benchmark | status | target accuracy | baseline accuracy | accuracy delta | target right/wrong | baseline right/wrong | target input | baseline input | target output | baseline output | target total tokens | baseline total tokens | total token delta | target cached % | baseline cached % | cached % delta | target LLM calls | baseline LLM calls | LLM call delta |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| swe_bench | missing | 0.0000 |  |  | 0/1 | / | 11038 |  | 8192 |  | 19230 |  |  | 0.00 |  |  | 2 |  |  |
| terminal_bench | missing | 0.0000 |  |  | 0/1 | / | 15235 |  | 13609 |  | 28844 |  |  | 44.53 |  |  | 20 |  |  |

## Token Totals By Adapter

| adapter | input | output | total | cached | cached % | LLM calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| elizaos | 26273 | 21801 | 48074 | 6784 | 25.82 | 22 |

## Token Evidence

Status: ok
Message: all cells produced LLM token telemetry

| benchmark | adapter | evidence | LLM calls | input | output | total | cached % | note |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| swe_bench | elizaos | present | 2 | 11038 | 8192 | 19230 | 0.00 | LLM call, token, and cache telemetry found |
| terminal_bench | elizaos | present | 20 | 15235 | 13609 | 28844 | 44.53 | LLM call, token, and cache telemetry found |

## Improvement Queue

| priority | benchmark | status | diagnosis | focus | next action | accuracy delta | target failure | baseline failure | target trajectories | baseline trajectories |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| p1 | swe_bench | missing | missing comparable outcome evidence | fix target harness/runtime failure before tuning prompts, restore trajectory capture for comparable review evidence, remove repeated prompt-prefix churn, reduce trajectory token load versus baseline | run live benchmark cell until both adapters have comparable outcome metrics |  | no_patch |  | /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist/swe_bench/elizaos/trajectories |  |
| p1 | terminal_bench | missing | missing comparable outcome evidence | fix target harness/runtime failure before tuning prompts, restore trajectory capture for comparable review evidence, remove repeated prompt-prefix churn, reduce trajectory token load versus baseline | run live benchmark cell until both adapters have comparable outcome metrics |  | tests_failed |  | /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist/terminal_bench/elizaos/trajectories |  |

### Queue Rerun Commands

```bash
python -m benchmarks.orchestrator.code_agent_matrix --rerun-queue {summary_json} --queue-priorities p1 --queue-statuses missing --compare-summary {summary_json} --provider cerebras --model gemma-4-31b --max-tasks 1 --timeout-seconds 3600 --run-root /private/tmp/eliza-comment-verify/.github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist --no-docker --force
```


### Trajectory Review Briefs

| benchmark | adapter | files | turns | input | output | cached % | repeated prefixes | notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| swe_bench | target | 1 | 2 | 11038 | 8192 | 0.00 | 1 | repeated prompt prefixes detected |
| swe_bench | baseline | 0 | 0 | 0 | 0 |  | 0 | no trajectory directory recorded |
| terminal_bench | target | 1 | 20 | 15235 | 13609 | 44.53 | 20 | repeated prompt prefixes detected |
| terminal_bench | baseline | 0 | 0 | 0 | 0 |  | 0 | no trajectory directory recorded |

### Trajectory Deltas

| benchmark | turn delta | input delta | output delta | total delta | cached % delta | repeated prefix delta | mean latency delta | p95 latency delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| swe_bench | 2 | 11038 | 8192 | 19230 |  | 1 |  |  |
| terminal_bench | 20 | 15235 | 13609 | 28844 |  | 20 |  |  |

## Failure Classes

- `no_patch`: 1
- `tests_failed`: 1
