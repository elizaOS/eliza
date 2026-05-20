# ElizaOS Benchmark Orchestrator

Run any integrated benchmark (or all benchmarks), store normalized results in
SQLite/JSON, and inspect history in the browser viewer.

Use the workspace Python (`/Users/shawwalters/eliza-workspace/.venv/bin/python`)
for consistent dependency versions across benchmark subprocesses.

## Paths

- Results DB: `benchmarks/benchmark_results/orchestrator.sqlite`
- Viewer dataset: `benchmarks/benchmark_results/viewer_data.json`
- Static viewer UI: `benchmarks/viewer/index.html`

## List integrated benchmarks

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator list-benchmarks
```

This verifies adapter coverage for all benchmark directories under `benchmarks/`.

## Run benchmarks idempotently

Run one benchmark:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks solana \
  --provider groq \
  --model openai/gpt-oss-120b
```

Run all benchmarks:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --all \
  --provider groq \
  --model openai/gpt-oss-120b
```

Idempotent behavior:

- Existing successful signatures are skipped automatically.
- `--rerun-failed` reruns only signatures whose latest run failed.
- `--force` always creates a fresh run.

Examples:

```bash
# rerun only failed signatures
/opt/miniconda3/bin/python -m benchmarks.orchestrator run --all --rerun-failed --provider groq --model openai/gpt-oss-120b

# force fresh runs
/opt/miniconda3/bin/python -m benchmarks.orchestrator run --all --force --provider groq --model openai/gpt-oss-120b
```

## Extra benchmark config

Use `--extra` with a JSON object for benchmark-specific knobs.
Adapter defaults are applied first, then `--extra` overrides are merged on top.
This keeps `run --all` idempotent with stable per-benchmark baseline settings
while still letting you override knobs when needed.

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks osworld \
  --provider groq \
  --model openai/gpt-oss-120b \
  --rerun-failed \
  --extra '{"max_tasks":1,"headless":true,"vm_ready_timeout_seconds":21600}'
```

`--extra` also supports a `per_benchmark` object for benchmark-specific overrides
in one `--all` run:

```bash
/Users/shawwalters/eliza-workspace/.venv/bin/python -m benchmarks.orchestrator run \
  --all \
  --agent eliza \
  --provider groq \
  --model openai/gpt-oss-120b \
  --extra "$(cat benchmarks/orchestrator/profiles/sample10.json)"
```

Profile included in repo:

- `benchmarks/orchestrator/profiles/sample10.json` - roughly 10% sampled run
  settings (where the benchmark supports sampling).
- `benchmarks/orchestrator/profiles/orchestrator_subagents.json` - orchestrator
  matrix profile for `swe_bench_orchestrated` and `orchestrator_lifecycle`.

Model profiles included in repo:

- `benchmarks/orchestrator/profiles/cerebras-gpt-oss-120b.json`
- `benchmarks/orchestrator/profiles/gpt-5.5.json`
- `benchmarks/orchestrator/profiles/claude-sonnet.json`
- `benchmarks/orchestrator/profiles/claude-opus.json`

Use them with `--model-profile`; benchmark `--extra` can still be combined
and overrides any profile `extra` keys:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks bfcl \
  --agent eliza \
  --model-profile cerebras-gpt-oss-120b \
  --extra '{"per_benchmark":{"bfcl":{"sample":10}}}'
```

For `cerebras-gpt-oss-120b`, the profile pins `reasoning_effort=low`.
The orchestrator exports that value as both `OPENAI_REASONING_EFFORT` and
`CEREBRAS_REASONING_EFFORT` for subprocesses, so OpenAI-compatible Eliza
runtime paths and direct Cerebras benchmark clients use the same setting.
Keep `CEREBRAS_API_KEY` in the shell environment or secret manager only; do
not commit it to a profile or `.env` file.

## Orchestrated Subagent Tracks

New orchestrator-centric benchmark IDs:

- `swe_bench_orchestrated`
- `orchestrator_lifecycle`
- `eliza_replay`

Code matrix example:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks swe_bench_orchestrated \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --extra '{"per_benchmark":{"swe_bench_orchestrated":{"matrix":true,"max_instances":3,"no_docker":true,"strict_capabilities":true}}}'
```

Lifecycle suite example:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle \
  --provider openai \
  --model gpt-4o \
  --extra '{"per_benchmark":{"orchestrator_lifecycle":{"max_scenarios":12,"strict":true}}}'
```

Replay scoring example (from normalized Eliza capture artifacts):

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks eliza_replay \
  --provider groq \
  --model openai/gpt-oss-120b \
  --extra '{"per_benchmark":{"eliza_replay":{"capture_path":"/path/to/replays","capture_glob":"*.replay.json"}}}'
```

`capture_path` is required and must point to a file or directory of normalized `*.replay.json` artifacts.

## Code Agent Matrix

Worker lane for comparing real coding agents across coding, terminal, browser,
and computer-use benchmarks. The default included matrix is sourced from
`benchmarks/orchestrator/code_agent_coverage.py` and currently covers
`swe_bench`, `terminal_bench`, `mind2web`, `visualwebbench`, `webshop`,
`osworld`, `swe_bench_multilingual`, `nl2repo`, `mint`, `app_eval_coding`,
`standard_humaneval`, `openclaw_benchmark`, `claw_eval`,
`qwen_claw_bench`, `clawbench`, and `agentbench`
for both `elizaos` and `opencode`.

```bash
cd /Users/shawwalters/milaidy/eliza
PYTHONPATH=packages python -m benchmarks.orchestrator.code_agent_matrix \
  --benchmarks swe_bench,terminal_bench,mind2web,visualwebbench,webshop,osworld,swe_bench_multilingual,nl2repo,mint,app_eval_coding,standard_humaneval,openclaw_benchmark,claw_eval,qwen_claw_bench,clawbench,agentbench \
  --adapters elizaos,opencode \
  --provider cerebras \
  --model gpt-oss-120b \
  --max-tasks 1 \
  --no-docker
```

The matrix writes one directory per `(benchmark, adapter)` cell under
`benchmark_results/code-agent-matrix/<timestamp>/`, preserving:

- `command.json` with the redacted command/environment metadata.
- `stdout.log` and `stderr.log` with secret-looking env values redacted.
- benchmark output JSON under each cell's `output/` directory.
- requested trajectory output under each cell's `trajectories/` directory.
- top-level `summary.json` and `summary.md` with failure buckets, normalized
  right/wrong/total/accuracy, input/output/cached token metrics, LLM call
  counts, run configuration metadata, an ElizaOS-vs-OpenCode head-to-head
  status per benchmark with target/baseline input, output, total, cached
  percentage, and LLM-call counts, and an explicit token-evidence section that
  flags cells where no usable LLM/token telemetry was captured. Reports also
  include a combined report gate for coverage, comparability, and required
  stats; a benchmark-coverage section showing selected included benchmarks and
  related deferred benchmarks; and an improvement queue pointing to logs,
  results, and trajectory directories for inferior, weak, or missing
  comparisons. `weak` means both adapters
  produced measured zero accuracy, so the result is not accepted as meaningful
  comparability. Queue entries include compact trajectory review briefs with
  turn/token counts, cached-token percentage, latency, repeated-prefix signals,
  and deterministic diagnosis strings that call out missing evidence, accuracy
  loss, failure classes, extra token/call cost, or cache regressions. They also
  include rerun command templates for targeted follow-up runs. Generated rerun
  templates preserve the original
  provider, model, task limit, timeout, run root, latest publish directory,
  smoke/dry-run mode, Docker mode, and comparable/token/stat enforcement flags
  while intentionally omitting secret env values and coverage enforcement. Coverage
  enforcement is reserved for full release-style matrix reports, not targeted
  reruns. `summary.json` also includes `report_rows`, a stable flat row set
  for longitudinal tracking with right/wrong, accuracy, token, cached-token,
  LLM-call, gate, release-readiness, blocking-requirement, and unblock-command
  fields per benchmark. The same rows are written as
  `report-rows.jsonl` and `report-rows.csv` beside the summary.

Add `--publish-latest-dir` to materialize the ElizaOS-vs-OpenCode report rows
as latest-style JSON artifacts:

```bash
PYTHONPATH=packages python -m benchmarks.orchestrator.code_agent_matrix \
  --benchmarks swe_bench,terminal_bench,mind2web,visualwebbench,webshop,osworld,swe_bench_multilingual,nl2repo,mint,app_eval_coding,standard_humaneval,openclaw_benchmark,claw_eval,qwen_claw_bench,clawbench,agentbench \
  --adapters elizaos,opencode \
  --provider cerebras \
  --model gpt-oss-120b \
  --max-tasks 1 \
  --force \
  --enforce-live-report \
  --enforce-trajectory-reviews \
  --enforce-report \
  --enforce-coverage \
  --enforce-comparable \
  --enforce-required-stats \
  --enforce-token-evidence \
  --enforce-efficiency \
  --publish-latest-dir packages/benchmarks/benchmark_results/latest-code-agent
```

The publisher writes one `<benchmark>__elizaos_vs_opencode.json` row per
comparison plus an `index.json` with a code-agent `matrix_contract`. Generated
follow-up commands preserve `--publish-latest-dir`, so reruns and release
unblock commands keep refreshing the same latest artifact set. Each publish
also prunes stale `*__elizaos_vs_opencode.json` rows from that directory while
leaving unrelated latest rows alone; `index.json` records the count under
`code_agent_matrix.stale_row_count`.

Code-agent latest rows are publishable only when they include live-mode
execution, command/result/trajectory provenance for both adapters,
right/wrong/total outcomes, input/output/total tokens, cached-token percentage,
LLM-call counts, accuracy/input/output/total-token/call/cache deltas, and a
`comparison_status` of `superior` or `comparable`. The publisher and validators
also require that trajectory telemetry backs the reported token, cache, and
LLM-call fields; that deltas equal target minus baseline; that `score`,
accuracy, and right/wrong/total fields agree; that `comparison_status` matches
the measured accuracy relationship; and that ElizaOS has no token/call/cache
efficiency regression versus OpenCode. Rows that fail that contract are still
written for review, but their `status` is `failed`, their row and `index.json`
cell include `failure_reason`/`failure_reasons`, and the code-agent
`matrix_contract.status` becomes `incomplete`.

Related benchmarks that are not yet release-comparable in this matrix are
tracked as deferred coverage rather than ignored. Current deferred entries
include `swe_bench_pro`, `qwen_web_bench`, and `vision_language`.
`swe_bench_pro` has an explicit patch-generation wrapper for the vendored
public split, matched ElizaOS/OpenCode command templates, patch normalization,
and token/call aggregation, but it remains deferred until non-mock public-split
patch generation is validated against local Docker or Modal scoring.
`qwen_web_bench` remains deferred until the public upstream runner and dataset
ship. `openclaw_benchmark` is included through the local
execution runner's setup/implementation/testing scenarios with shared-sandbox
tool execution and deterministic rubric scoring. `clawbench` is included
through its deterministic scenario fixtures and non-LLM rubric scorer, with
both adapters routed through the same Eliza benchmark bridge. `agentbench` is
included as an OS/WebShop/Mind2Web-related fixture slice over AgentBench's
environment adapters, again using the same ElizaOS/OpenCode bridge for live
agent turns. `qwen_claw_bench` is included as the deterministic automated
workspace task from QwenClawBench, using the benchmark's embedded Python
grader while leaving hybrid and LLM-judge tasks deferred until judge
dependencies are stable. `vision_language` tracks the eliza-1
vision-CUA/plugin-computeruse harness and now has explicit
ElizaOS/OpenCode harness labels in the vision-language runner, but remains
deferred until those labels have non-stub right/wrong/token telemetry. These
entries are tracked so front-end code-generation, workspace, terminal,
browser, and computer-use coverage is not silently omitted from the code-agent
roadmap. `nl2repo` is included in the release matrix. Smoke mode uses canonical
task metadata without Docker scoring. Live generation uses the repo-native
helper by default; set
`NL2REPO_AGENT_COMMAND_TEMPLATE` or
`NL2REPO_AGENT_COMMAND_TEMPLATE_<ADAPTER>` to override it. Set
`NL2REPO_DISABLE_BUILTIN_AGENT_COMMAND=1` only when intentionally validating
external command-template wiring. Live release-comparable scoring also requires
Docker so the upstream per-task evaluator image can run.

`swe_bench_pro` can be selected explicitly through the matrix even while it is
deferred from release readiness. The wrapper loads the vendored public JSONL,
builds one workspace per instance, drives the selected adapter through a
matched patch-generation command template, writes `.pred` files plus
`patches.json`, and normalizes generated/evaluated patches into right/wrong,
token, cached-token, and LLM-call fields. Smoke mode is offline. Live
release-comparable scoring requires local Docker or Modal evaluator validation
before this benchmark can move from deferred to included. Set
`SWE_BENCH_PRO_EVALUATOR_BACKEND=modal` to use Modal instead of the default
local-Docker evaluator, and `SWE_BENCH_PRO_EVAL_NUM_WORKERS=<n>` to tune
upstream evaluator parallelism.

`mint` is included as a coding slice rather than the full benchmark. The matrix
selects the MINT HumanEval/MBPP code-generation subtasks, preserves the
multi-turn tool/feedback loop, and reports turn-k success in addition to the
normalized right/wrong/total fields. Smoke mode uses the offline HumanEval
fixture; live mode lazy-fetches upstream coding samples unless a cache or data
path is already populated.

`app_eval_coding` is also included in the release matrix. It materializes the
App Eval coding task workspaces, runs each adapter through a matched command
template, then scores the declared file, command-output, and test assertions.
Live generation uses the repo-native helper by default; set
`APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE` or
`APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE_<ADAPTER>` to override it. Set
`APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND=1` only when intentionally
validating external command-template wiring.

`openclaw_benchmark` is included through the local OpenClaw execution runner.
The matrix runs the setup, implementation, and testing scenarios in dependency
order with one shared sandbox so downstream tasks can use prerequisite files,
then normalizes rubric scores into right/wrong/total fields. Smoke mode uses a
deterministic offline setup fixture; live mode routes each LLM turn through the
ElizaOS/OpenCode bridge and writes trajectory/token telemetry beside the cell
artifacts.

`claw_eval` is included as a deterministic coding slice over Claw-Eval tasks
whose YAML scoring components do not require an LLM judge. The wrapper runs the
same CUDA-kernel-review and JavaScript async-tracing tasks for both adapters,
scores keyword/tool-use components from the task definitions, and preserves the
full hybrid/browser/multimodal Claw-Eval expansion path as future work.

`clawbench` is included through the local single-turn scenario runner. The
matrix selects the same fixture-backed scenarios for both adapters, scores
response/tool-call behavior with the deterministic ClawBench rubric, and
normalizes fractional rubric scores into right/wrong/total fields.

`agentbench` is included as a deterministic OS/WebShop/Mind2Web-related slice.
The wrapper runs compact AgentBench fixture tasks for operating-system,
shopping, and browser-action environments, preserving AgentBench's environment
step loop while normalizing pass/fail outcomes into the matrix report rows.

`qwen_claw_bench` is included as the QwenClawBench automated workspace slice.
The wrapper selects the non-LLM-judged task, prepares its Downloads workspace,
runs each adapter through the same command-template helper, and invokes the
benchmark's embedded Python grader. Live generation uses the repo-native helper
by default; set `QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE` or
`QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE_<ADAPTER>` to override it.

Smoke mode uses each benchmark's cheap offline fixtures where available:
Mind2Web `--sample --mock`, VisualWebBench `--use-sample-tasks --mock`,
WebShop `--use-sample-tasks --mock`, and OSWorld `--dry_run`. Real WebShop
runs add `--bridge`; real OSWorld runs do not add `--dry_run`, so they require
the desktop/VM capacity expected by OSWorld.

Resume is default: cells with `cell-result.json` are reused. Add `--force` to
rerun, or summarize an interrupted/keyed run without executing anything:

```bash
cd /Users/shawwalters/milaidy/eliza/packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --summarize /path/to/benchmark_results/code-agent-matrix/20260516T120000Z
```

To rerun only queued comparisons from a previous report, point at its
`summary.json`. This is useful after fixing ElizaOS behavior on one inferior
benchmark because it avoids rebuilding the full matrix:

```bash
cd /Users/shawwalters/milaidy/eliza/packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --rerun-queue /path/to/benchmark_results/code-agent-matrix/20260516T120000Z/summary.json \
  --compare-summary /path/to/benchmark_results/code-agent-matrix/20260516T120000Z/summary.json \
  --queue-priorities p0 \
  --force
```

Use `--compare-summary` on any full or queued rerun to add a previous-summary
comparison table showing ElizaOS accuracy, token, cached-token, and LLM-call
deltas by benchmark.

When ElizaOS is accuracy-comparable but less efficient, `summary.json` includes
an `efficiency_queue` and the markdown includes an Efficiency Queue section.
This flags higher total-token use, extra LLM calls, and lower cached-token
percentage versus OpenCode so optimization work is not hidden by a passing
accuracy gate.

Use `--enforce-comparable` in CI or release gates to exit nonzero unless every
selected benchmark is `superior` or `comparable` for ElizaOS against OpenCode.
Inferior, weak, and missing comparisons block the gate. The generated
`summary.json` always includes `benchmark_gate` with the same blocking
benchmark list.

Use `--enforce-coverage` when the report must cover every benchmark currently
marked included in `code_agent_coverage.py`. This is separate from queued or
single-benchmark reruns: partial reruns can still produce useful comparison
and trajectory evidence, while full release reports can require the coverage
gate.

Use `--enforce-token-evidence` for live runs where token telemetry is required.
It exits nonzero unless every selected cell produced usable LLM-call, token
usage, and cached-token percentage evidence. This should usually be omitted for
no-LLM smoke fixtures.

Use `--enforce-required-stats` when a run should fail unless the report has
all stats required for the head-to-head benchmark claim. It checks measured
right/wrong/total outcome evidence for every selected benchmark and requires
token evidence for live runs. Smoke, dry-run, and summarize reports do not
require token evidence unless `--enforce-token-evidence` is also set.

Use `--enforce-efficiency` when a run should fail if ElizaOS is less efficient
than OpenCode on total tokens, LLM-call count, or cached-token percentage.
When combined with `--enforce-report`, the combined report gate includes the
efficiency gate.

Use `--enforce-no-regression` with `--compare-summary` when a follow-up report
must not reduce ElizaOS target accuracy versus the previous report. When
combined with `--enforce-report`, the combined report gate includes the
no-regression gate.

Use `--quality-guardrail-summary` to attach the JSON output from
`PYTHONPATH=packages python -m benchmarks.orchestrator validate-latest-readiness --skip-runtime-gates --exclude-benchmarks <code-agent-benchmark-csv> --json`
for the broader benchmark matrix. This validates the latest published
non-code-quality evidence without circularly re-validating the code-agent
benchmarks under release, and without letting host-specific runtime probes,
such as Docker availability for code benchmarks, block the guardrail artifact.
Add `--enforce-quality-guardrail` when a code-agent report must fail unless
that broader readiness report is present and clean. When combined with
`--enforce-report`, the combined report gate includes the quality guardrail.
Preflight reports include selected-scope
`live_evidence`, runnable-deferred `deferred_live_evidence`, full-scope
`release_preflight`, and full-scope `release_comparable` commands. The live and
release-comparable commands carry `--enforce-token-evidence`; the release and
deferred-live commands always use the ElizaOS/OpenCode adapter pair so a
single-adapter preflight cannot accidentally become release evidence. The
release commands also carry
`--quality-guardrail-summary /path/to/non-code-quality-guardrail.json` as an
explicit placeholder because final release readiness cannot pass without this
non-code guardrail evidence.

Use `--enforce-trajectory-reviews` when a run should fail unless every selected
cell has reviewable trajectory files, turns, and cached-token telemetry. When
combined with `--enforce-report`, the combined report gate includes the
trajectory review gate.

Use `--enforce-live-report` when smoke, dry-run, or summarize artifacts must
not be accepted as benchmark evidence. This fails unless the matrix ran in
live mode. When combined with `--enforce-report`, the combined report gate
includes the live-report gate.

Use `--enforce-report` for a single release-readiness exit code over the
combined report gate. It fails unless coverage, comparability, and required
stats all pass for the generated report, plus efficiency when
`--enforce-efficiency` is set and no-regression when `--enforce-no-regression`
is set, quality readiness when `--enforce-quality-guardrail` is set,
trajectory review coverage when `--enforce-trajectory-reviews` is set, and
live execution when `--enforce-live-report` is set. Use
`--enforce-release-readiness` when automation should fail unless the final
release-readiness checklist passes, including live execution, full included
coverage, no remaining deferred related code/browser/terminal/computer-use
benchmarks, comparable-or-better outcomes, right/wrong and token telemetry,
trajectory reviews, efficiency, and the broader non-code quality guardrail.

The generated `summary.json` includes an `exit_codes` map for automation plus
the selected run result as `exit_code` and `exit_reason`. The rendered
`summary.md` mirrors those selected fields in a `Run Result` section, so humans
and automation can see the enforced gate that decided the process exit. The
current exit-code contract is:

| code | name | meaning |
| --- | --- | --- |
| 0 | `ok` | run completed without an enforced gate failure |
| 2 | `preflight_failed` | preflight checks failed |
| 3 | `comparable_gate_failed` | ElizaOS was not comparable-or-better than OpenCode on every selected benchmark |
| 4 | `token_evidence_failed` | one or more selected cells lacked usable LLM token telemetry |
| 5 | `required_stats_failed` | one or more selected benchmarks lacked required outcome or token stats |
| 6 | `coverage_gate_failed` | the run did not cover every included code-agent benchmark |
| 7 | `report_gate_failed` | the combined release-readiness report gate failed |
| 8 | `efficiency_gate_failed` | ElizaOS used more tokens, made more LLM calls, or had lower cached-token percentage than OpenCode |
| 9 | `no_regression_failed` | ElizaOS regressed against the previous comparison summary |
| 10 | `quality_guardrail_failed` | the broader non-code benchmark readiness guardrail failed |
| 11 | `trajectory_review_failed` | one or more selected cells lacked reviewable trajectory telemetry |
| 12 | `live_report_failed` | the report was not generated from live benchmark execution |
| 13 | `release_readiness_failed` | the final release-readiness checklist failed |

Before a run, use `--preflight` to check the OpenCode adapter executable,
benchmark working directories, command executables, and provider keys for live
runs. Smoke and dry-run preflights do not require provider keys because they do
not make LLM calls. Explicit preflights and blocked normal runs write
`preflight.json` and `preflight.md` under the selected run root, including
`exit_code: 2` and `exit_reason: preflight_failed` when the preflight is
blocked, so blocked live-run readiness is tracked without creating a benchmark
`summary.json`. These artifacts include retry, live-evidence, and
release-comparable command templates with the selected benchmark scope and
release gates. Blocked preflights also include structured unblock steps, such
as the provider key to export, the `OPENCODE_BIN` override to set, whether
Docker needs to be installed or started, or whether NL2Repo should use the
built-in agent helper:

```bash
cd /Users/shawwalters/milaidy/eliza/packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --preflight \
  --smoke \
  --no-docker \
  --max-tasks 1
```

No-key smoke/dry validation:

```bash
cd /Users/shawwalters/milaidy/eliza/packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --dry-run \
  --smoke \
  --no-docker \
  --max-tasks 1 \
  --run-root /tmp/eliza-code-agent-matrix-smoke
```

For a real opencode cell, keep `CEREBRAS_API_KEY` in the shell environment and
ensure the `opencode` CLI is installed or set `OPENCODE_BIN`. The matrix does
not write provider key values into `command.json`; subprocess logs are redacted
before being persisted.

## Viewer

Serve live viewer API + UI:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator serve-viewer --host 127.0.0.1 --port 8877
```

Open: `http://127.0.0.1:8877/`

Viewer supports:

- Historical runs across all benchmarks.
- Sorting by `agent`, `run_id`, and other columns.
- High-score comparison columns (`high_score`, `delta`).
- Filtering by benchmark/status and text search.

## Rebuild viewer dataset

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator export-viewer-data
```

## Validate latest benchmark readiness

Use these gates before treating `benchmark_results/latest/` as publishable.
They are intentionally stricter than `export-viewer-data`: latest rows must be
real successful runs with numeric scores, no sample/demo/mock/stub markers, and
comparable real-harness scores.

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-matrix
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-runtime-gates
/opt/miniconda3/bin/python -m benchmarks.orchestrator calibration-report --tolerance 0.08
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-latest-publishability
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-latest-comparability --tolerance 0.08
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-latest-readiness --tolerance 0.08
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-latest-readiness --tolerance 0.08 --skip-runtime-gates --exclude-benchmarks agentbench,app_eval_coding,claw_eval,clawbench,mind2web,mint,nl2repo,openclaw_benchmark,osworld,qwen_claw_bench,qwen_web_bench,standard_humaneval,swe_bench,swe_bench_multilingual,swe_bench_pro,terminal_bench,vision_language,visualwebbench,webshop --json > /path/to/non-code-quality-guardrail.json

# Code-agent latest artifacts from --publish-latest-dir:
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-latest-publishability --latest-dir packages/benchmarks/benchmark_results/latest-code-agent --include-benchmarks swe_bench
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-latest-comparability --latest-dir packages/benchmarks/benchmark_results/latest-code-agent --include-benchmarks swe_bench --tolerance 0.08
/opt/miniconda3/bin/python -m benchmarks.orchestrator validate-latest-readiness --latest-dir packages/benchmarks/benchmark_results/latest-code-agent --include-benchmarks swe_bench --skip-runtime-gates
```

`validate-latest-readiness` is the completion gate. It fails unless every
Eliza/Hermes/OpenClaw cell required by the latest matrix is present,
successful, scored, publishable, and comparable. Unsupported cells include
their reason in `latest/index.json` under `matrix_contract.benchmarks`.
For code-agent latest directories produced by `--publish-latest-dir`, the same
publishability/readiness validators also enforce the ElizaOS-vs-OpenCode
contract: complete provenance, right/wrong stats, token/cache/call stats,
efficiency deltas, comparable-or-better status, no token/call/cache regression,
and a complete code-agent `matrix_contract`.
`validate-latest-comparability --latest-dir <dir>` also understands the
code-agent `elizaos_vs_opencode` required cell and fails if the row is missing,
failed, unscored, or not marked `superior`/`comparable`. Use
`--include-benchmarks` or `--exclude-benchmarks` on
publishability/comparability/readiness validators when checking a narrowed
latest artifact set.
`validate-runtime-gates` probes the current host for the external services and
credentials that unlock benchmarks where sample/demo fallbacks are forbidden.

Expected real-runtime gates:

- Hyperliquid rows require `HL_PRIVATE_KEY` and live execution with demo mode
  disabled.
- Terminal-Bench and Hermes sandbox-family rows require either a reachable
  Docker daemon or, where supported, Modal credentials.
- Vision-language Hermes/OpenClaw rows require `VISION_LANGUAGE_MODEL` plus
  provider credentials for a multimodal OpenAI-compatible model.

## Recover stale/interrupted runs

If an orchestrator process is interrupted, rows can remain in `running` state.
Recover them immediately and regenerate the viewer dataset:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator recover-stale-runs --stale-seconds 0
```

Default behavior only recovers runs older than 300 seconds:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator recover-stale-runs
```

## Show runs in terminal

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator show-runs --desc --limit 200
```

`show-runs` is sorted by `(agent, run_id)` and is useful for quick auditing.

## Comparing models (A vs B)

Run any benchmark suite against two models and print a side-by-side delta
table. Each side is a separate run group in SQLite, but both runs share a
``comparison_id`` so the comparison can be re-rendered later.

Spec format for ``--a`` / ``--b``: ``<provider>:<model>[@<base_url>]``.
The optional ``@<base_url>`` is forwarded to the provider as an OpenAI-
compatible base URL; for the ``vllm`` provider this points the orchestrator at
a self-hosted vLLM endpoint started via ``vllm serve``.

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator compare \
  --a "vllm:elizaos/eliza-1@http://127.0.0.1:8001/v1" \
  --b "vllm:Qwen/Qwen3.5-2B@http://127.0.0.1:8002/v1" \
  --benchmarks action-calling,bfcl,realm,context-bench
```

Optional flags:

- ``--max-examples N`` caps work per benchmark (forwarded as
  ``max_examples`` / ``max_tasks`` / ``sample`` so individual adapters pick it
  up however they natively wire sampling).
- ``--temperature 0.0`` (default).
- ``--out <dir>`` — directory for ``compare-<comparison_id>.json``. Defaults
  to ``benchmarks/benchmark_results/comparisons/``.

Output:

```
Comparison ID: cmp_20260504T120000Z_a1b2c3d4
A: vllm:elizaos/eliza-1 @ http://127.0.0.1:8001/v1
B: vllm:Qwen/Qwen3.5-2B @ http://127.0.0.1:8002/v1
Benchmarks: action-calling, bfcl, realm, context-bench

benchmark      | A: vllm:elizaos/eliza-1 | B: vllm:Qwen/Qwen3.5-2B | delta (B-A) | winner
---------------+----------------------------+-------------------------+-------------+-------
action-calling | 0.9120                     | 0.7430                  | -0.1690     | A
bfcl           | 0.6840                     | 0.6920                  | +0.0080     | B
realm          | 0.5510                     | 0.5310                  | -0.0200     | A
context-bench  | 0.7400                     | 0.7250                  | -0.0150     | A

Wrote benchmarks/benchmark_results/comparisons/compare-cmp_20260504T120000Z_a1b2c3d4.json
```

Re-render a stored comparison:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator view-comparison \
  cmp_20260504T120000Z_a1b2c3d4
```

The ``vllm`` provider name is registered alongside ``openai`` / ``groq`` /
``anthropic``: every benchmark CLI that already accepts ``--provider``
accepts ``--provider vllm``, and the orchestrator forwards
``OPENAI_BASE_URL`` to the per-benchmark subprocess so OpenAI-compatible
clients hit the vLLM endpoint without code changes. Override the default
``http://127.0.0.1:8001/v1`` either via ``@<base_url>`` in the spec, the
``VLLM_BASE_URL`` env var, or the per-run ``vllm_base_url`` extra config.

## Stored metadata per run

Each run stores:

- benchmark ID + directory
- run ID + run group ID + signature + attempt
- status, duration, score, metrics, artifacts
- provider, model, agent label
- extra config used for the run
- benchmark and Eliza commit/version metadata
- high-score reference and delta
