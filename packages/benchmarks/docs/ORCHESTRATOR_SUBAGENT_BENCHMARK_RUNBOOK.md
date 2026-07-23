# Orchestrator Sub-Agent Benchmark Runbook

This runbook is the validation loop for the ElizaOS coding agent, OpenCode,
Pi Agent, and the swarm/orchestrator layer.

## Current Wiring

- Default code-agent adapter is `elizaos` through
  `ELIZA_ACP_DEFAULT_AGENT` / `ELIZA_DEFAULT_AGENT_TYPE`.
- Settings can switch the default to `opencode` or `pi-agent`; with
  `ELIZA_AGENT_SELECTION_STRATEGY=fixed`, the configured default wins over a
  planner guess.
- Benchmark matrix runs override the default with `BENCHMARK_TASK_AGENT`.
- Sub-agent routing uses existing rooms. Each spawned session receives
  task-room and optional worktree-room metadata, plus instructions for
  `QUESTION_FOR_TASK_CREATOR` and `AGENT_COORDINATION`.
- The coding tool surface should stay narrow: read/search files, edit/write
  patches, shell/test commands, git/diff inspection, task status, and swarm or
  parent communication. Avoid loading broad personal-data, connector, media, or
  unrelated app actions into coding sub-agents.

OpenCode's relevant built-in tool surface is broader than the minimum:
`read`, `write`, `edit`, `apply_patch`, `glob`, `grep`, shell/bash, LSP,
todo, task/subagent, question, skill, repo clone/overview, web fetch/search,
and plugin/MCP tools. The ElizaOS coding profile should start with the narrow
subset above, then add only tools justified by failed trajectories.

## Matrix Coverage

The executable coverage manifest lives in
`packages/benchmarks/orchestrator/code_agent_coverage.py`; tests assert that
its included IDs match `DEFAULT_BENCHMARKS`.

The code-agent matrix currently covers the benchmark families that have a
thin, repeatable Eliza bridge path and enough structured output for
head-to-head reporting:

- `swe_bench` — SWE-bench Lite through the shared SWE-bench bridge.
- `swe_bench_multilingual` — SWE-bench Multilingual through the same bridge,
  reported separately because it stresses non-Python code repair.
- `terminal_bench` — terminal task execution.
- `mind2web` — browser/navigation DOM-action tasks.
- `visualwebbench` — visual web understanding and grounding.
- `webshop` — simulated e-commerce web-interaction tasks using Princeton
  WebShop's reward function.
- `osworld` — desktop/computer-use tasks.

`swe-bench-pro` is intentionally not a default matrix cell yet. The vendored
tree uses a separate prediction-gather plus Docker/Modal evaluation workflow,
so it needs a dedicated adapter before its results would be comparable to the
other matrix cells.

`nl2repo`, `app-eval`, `vision-language`, AgentBench/MINT, and the
CLaw/OpenCLaw/QwenClaw suites are not default code-agent matrix cells yet.
They are relevant adjacent benchmarks, but they either need a dedicated
Eliza-vs-OpenCode adapter, use a different model/runtime surface, require
heavy external datasets or LLM judges, or are broader general-agent/regression
suites rather than comparable coding-agent cells. Add them only after their
runner can emit the same structured right/wrong, cached-token, input/output
token, LLM-call, result-path, and trajectory artifacts as the default matrix.

## Secrets

Keep provider keys in the process environment or a secret manager only.
Do not commit keys into profiles, `.env`, run artifacts, or docs.

For Cerebras gemma-4-31b:

```bash
export CEREBRAS_API_KEY=...
```

The matrix harness redacts secret-looking values from `command.json`,
`stdout.log`, `stderr.log`, JSON, JSONL, text, and Markdown artifacts.

## Smoke Validation

From the repository root:

```bash
cd packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --dry-run \
  --smoke \
  --no-docker \
  --max-tasks 1 \
  --benchmarks swe_bench,swe_bench_multilingual,terminal_bench,mind2web,visualwebbench,webshop,osworld \
  --adapters elizaos,opencode,pi-agent \
  --provider cerebras \
  --model gemma-4-31b \
  --run-root /tmp/eliza-code-agent-matrix-smoke
```

Expected checks:

- one cell for each `(swe_bench|swe_bench_multilingual|terminal_bench|mind2web|visualwebbench|webshop|osworld) x (elizaos|opencode|pi-agent)`;
- `BENCHMARK_TASK_AGENT` matches the cell adapter;
- no provider key appears in command metadata;
- `summary.json` and `summary.md` are written with right/wrong counts,
  cached-token percent, input/output/total tokens, LLM call count, and the
  `head_to_head` ElizaOS-vs-OpenCode section.
- `summary.json.coverage` reports seven included benchmarks and the deferred
  adjacent suites from `code_agent_coverage.py`.

Before a publishable run, use preflight. It writes `preflight.json` and
`preflight.md` and exits before running cells:

```bash
cd packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --preflight \
  --benchmarks swe_bench,swe_bench_multilingual,terminal_bench,mind2web,visualwebbench,webshop,osworld \
  --adapters elizaos,opencode,pi-agent \
  --provider cerebras \
  --model gemma-4-31b \
  --max-tasks 1
```

Preflight rejects missing provider credentials for live runs, missing
benchmark entrypoints and working directories, a missing `opencode` CLI when
the opencode adapter is selected, and a missing Docker CLI or daemon where a
selected benchmark requires Docker. Add `--enforce-release-readiness` together
with `--quality-guardrail-summary /path/to/non-code-quality-guardrail.json` to
also require a clean non-code quality-guardrail report at preflight time.
The publishable comparison adapter pair is always `elizaos` target vs
`opencode` baseline.

## Real Comparison Run

Start small and resumable:

```bash
cd packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --benchmarks swe_bench,swe_bench_multilingual,terminal_bench,mind2web,visualwebbench,webshop,osworld \
  --adapters elizaos,opencode,pi-agent \
  --provider cerebras \
  --model gemma-4-31b \
  --max-tasks 1 \
  --timeout-seconds 3600
```

The seven-benchmark commands run with Docker enabled: `osworld` defaults to
Docker execution, and preflight rejects `--no-docker` for osworld unless an
alternate provider (`OSWORLD_PROVIDER_NAME=vmware|virtualbox|aws`) is
configured. Use `--no-docker` only on subsets that exclude osworld.

Then run three independent passes:

```bash
for i in 1 2 3; do
  python -m benchmarks.orchestrator.code_agent_matrix \
    --benchmarks swe_bench,swe_bench_multilingual,terminal_bench,mind2web,visualwebbench,webshop,osworld \
    --adapters elizaos,opencode,pi-agent \
    --provider cerebras \
    --model gemma-4-31b \
    --max-tasks 1 \
    --force
done
```

After repeated runs, attach the longitudinal ElizaOS-vs-OpenCode trend by
re-summarizing the latest run against a previous run's `summary.json`:

```bash
python -m benchmarks.orchestrator.code_agent_matrix \
  --summarize benchmark_results/code-agent-matrix/<latest-run> \
  --compare-summary benchmark_results/code-agent-matrix/<previous-run>/summary.json
```

To index every run under one browsable HTML overview:

```bash
python -m benchmarks.orchestrator.code_agent_matrix \
  --write-run-index benchmark_results/code-agent-matrix/index \
  --index-scan-root benchmark_results/code-agent-matrix
```

Each run writes:

- `benchmark_results/code-agent-matrix/<timestamp>/summary.json`
- `summary.md`
- per-cell `command.json`, `stdout.log`, `stderr.log`
- benchmark output JSON
- trajectories under each cell's `trajectories/`

The top-level summaries are the comparison scorecard: each cell records
`outcome_metrics.right`, `outcome_metrics.wrong`, `token_metrics.input_tokens`,
`token_metrics.output_tokens`, `token_metrics.total_tokens`,
`token_metrics.cached_token_percent`, and `token_metrics.llm_call_count`.
The `evidence` block records `run_mode`, required provider env-var names,
whether provider credentials were present, and `publishable_live_evidence`.
Treat smoke, dry-run, mock-only, missing-credential, and provider-auth-failure
summaries as validation artifacts, not reportable benchmark evidence.
The `coverage` block records which included benchmark IDs were selected, which
included IDs were omitted, any unknown selected IDs, and all deferred adjacent
suites with reasons. Publishable gates reject summaries or trends that do not
cover every included benchmark.
The `head_to_head` section compares `elizaos` against `opencode` by benchmark,
including accuracy, total-token, and LLM-call deltas plus trajectory directory
pointers for both cells. Each comparison also includes `triage_hints`, which
flag target failure class, missing trajectory artifacts, missing token
telemetry, and higher ElizaOS token or LLM-call usage.
The `review_queue` section ranks the rows that need attention first, starting
with inferior ElizaOS rows, then target failures, missing comparisons, missing
telemetry or trajectories, and finally higher token/call usage.
For every queued row, `trajectory_reviews` adds prompt-safe target/baseline
trajectory summaries and token-heavy turn pointers so the first inspection can
start from the highest-signal turns before reading full trajectories.
`improvement_backlog` converts the same rows into evidence-scoped hypotheses
and recommended next actions, so live inferior rows become concrete Eliza
patch tasks instead of loose notes.
With `--compare-summary`, the summary gains a `previous_summary_comparison`
section (and a trend table in `summary.md`): per-benchmark trend status
(`improved` / `unchanged` / `regressed` / `missing`), target-accuracy deltas,
accuracy-gap change, and target token / cached-percent / LLM-call deltas.
Add `--enforce-no-regression` to exit nonzero if ElizaOS target accuracy
regressed against the compared summary.
Before publishing results, run with the enforcement stack the tool itself
recommends in `preflight.json.next_commands` (`release_comparable`):
`--enforce-live-report --enforce-trajectory-reviews --enforce-report
--enforce-coverage --enforce-comparable --enforce-required-stats
--enforce-token-evidence --enforce-efficiency --enforce-release-readiness`.
These exit nonzero unless the evidence is live provider-backed, covers all
included benchmark IDs, has no inferior or missing ElizaOS rows, and includes
coherent right/wrong/total counts, accuracy values that match `right / total`,
integer input/output/total-token and LLM-call counts,
`total_tokens == input_tokens + output_tokens`, and cached-token percent for
both adapters on every compared row.

If claiming code-agent improvements did not sacrifice non-code quality, also
require a clean non-code quality-guardrail artifact:

```bash
PYTHONPATH=packages python -m benchmarks.orchestrator validate-latest-readiness \
  --skip-runtime-gates \
  --exclude-benchmarks agentbench,mind2web,mint,nl2repo,osworld,standard_humaneval,swe_bench,terminal_bench,vision_language,visualwebbench,webshop \
  --json > /path/to/non-code-quality-guardrail.json

python -m benchmarks.orchestrator.code_agent_matrix \
  --summarize benchmark_results/code-agent-matrix/<latest-run> \
  --quality-guardrail-summary /path/to/non-code-quality-guardrail.json \
  --enforce-quality-guardrail
```

A guardrail summary is clean when it is a readiness report with `ok: true` and
an empty `findings` list. A missing or failing guardrail summary keeps the
code-agent run non-publishable when `--enforce-quality-guardrail` (or
`--enforce-release-readiness`) is set.

Summarize an interrupted or completed run without re-executing:

```bash
cd packages
python -m benchmarks.orchestrator.code_agent_matrix \
  --summarize /path/to/benchmark_results/code-agent-matrix/<timestamp>
```

## Triage Loop

1. Read `summary.json.review_queue` and the Review Queue table in `summary.md`.
2. For each queued row, open the listed ElizaOS trajectory directory and the
   matching OpenCode trajectory directory.
3. Use `summary.json.head_to_head.comparisons[].triage_hints` to prioritize the
   first suspected cause before reading full logs.
4. If the head-to-head section is missing because one adapter did not run,
   compare `summary.json` by adapter and benchmark manually.
5. Find cases where OpenCode has `pass` or a higher score and ElizaOS has
   `no_patch`, `patch_apply_failed`, `tests_failed`, `timeout`,
   `auth_or_provider`, or `stopped_early`.
6. Read the ElizaOS trajectory and logs first, then the matching OpenCode
   trajectory.
7. Classify the cause as prompt/tooling/provider/harness/coordination.
8. Patch the smallest surface:
   - prompt/instructions when the agent stopped early or failed to persist a
     patch;
   - tool whitelist when it lacks an OpenCode capability that mattered;
   - provider/env routing when auth or model calls failed;
   - swarm routing when agents missed coordination or user-question flow.
9. Re-run only the failed cells with `--force` or a higher `--max-tasks` once
   the small set is stable.

Do not add broad actions because a single trajectory failed. Add a capability
only when it is repeatedly needed for coding or terminal tasks and can be
tested.

For SWE-bench `no_patch` triage, first replay patch extraction against the
latest ElizaOS telemetry. This separates empty responses from parser misses and
from diffs that need repository source context:

```bash
PYTHONPATH=packages python - <<'PY'
import json
from collections import Counter
from pathlib import Path
from benchmarks.swe_bench import cli

telemetry = Path(
    "benchmark_results/code-agent-matrix/<run>/swe_bench/elizaos/trajectories/telemetry.jsonl"
)
counts = Counter()
for line in telemetry.read_text(errors="replace").splitlines():
    obj = json.loads(line)
    text = obj.get("response_text") or obj.get("response") or ""
    candidate = cli._extract_patch_candidate(text) if text else ""
    if not text:
        counts["empty_response"] += 1
    elif not candidate:
        counts["no_candidate"] += 1
    elif cli._extract_patch(text):
        counts["valid_without_repo"] += 1
    else:
        counts[cli._unified_diff_error(cli._sanitize_patch_text(candidate))] += 1
print(dict(counts))
PY
```

`no_candidate` should be rare. If it is not, patch extraction likely missed a
model-output shape. If most failures are invalid hunk headers, inspect whether
`_candidate_context_paths` included the source files needed to repair bare
model hunk headers before changing the agent prompt.

## Swarm Validation

For orchestrated sub-agent behavior, validate these separately from single
agent scoring:

- task room receives final status and questions for the creator;
- worktree room receives coordination messages when agents touch overlapping
  files;
- if task and worktree rooms collapse to one room, routing sends one message;
- sub-agent names/labels are preserved in session metadata and synthetic
  messages;
- blocked/question events ping the task creator through the originating
  channel and wait for the follow-up before continuing;
- agents include changed files, tests run, risks, and coordination state in
  final reports.

## Success Bar

ElizaOS is comparable when, over at least three runs on the same task sample:

- it writes patches consistently;
- it does not underperform OpenCode on every run;
- failures are explainable from trajectories rather than missing artifacts;
- any OpenCode-only win is mapped to an actionable ElizaOS change or a known
  benchmark variance.
