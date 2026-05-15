# elizaOS Swarm Coding Agent

Date: 2026-05-15

## Goal

Make `elizaos` the default coding-agent backend for
`@elizaos/plugin-agent-orchestrator`, while keeping the default configurable
between:

- `elizaos`
- `pi-agent`
- `opencode`

Claude Code and Codex remain available as explicit ACP adapters, but the
default path should optimize for repo-native elizaOS workers running
`gpt-oss-120b` through the configured provider, including Cerebras.

## Current OpenCode Inventory

Vendored OpenCode lives under `vendor/opencode/packages/opencode/src`.

OpenCode exposes a broad coding surface:

- shell execution: `tool/shell.ts`
- file reads/writes/edits: `tool/read.ts`, `tool/write.ts`, `tool/edit.ts`,
  `tool/apply_patch.ts`
- search/navigation: `tool/grep.ts`, `tool/glob.ts`, `tool/lsp.ts`,
  `tool/repo_overview.ts`
- planning/task helpers: `tool/todo.ts`, `tool/plan.ts`, `tool/task.ts`,
  `tool/question.ts`
- web/repo helpers: `tool/webfetch.ts`, `tool/websearch.ts`,
  `tool/repo_clone.ts`
- skills and MCP: `tool/skill.ts`, `mcp/*`

That is a strong general-purpose coding-agent surface, but it is larger than
the default elizaOS worker needs for SWE-bench-style repair loops.

## Default elizaOS Worker Surface

The first default elizaOS worker should stay narrow:

- shell command execution
- file read
- file search/glob
- file edit/patch/write
- test/lint/typecheck command execution
- task/worktree coordination messages
- parent-agent broker requests for context or user-mediated actions

Avoid exposing unrelated owner/device/browser/payment/connectors directly to
workers. The worker can ask the parent through the broker when it needs
private context, an external connector, a paid action, or user input.

## Swarm Coordination

Each spawned worker receives:

- a stable sub-agent name
- a task chat key shared by all sub-agents spawned for the same task
- a worktree chat key shared by all sub-agents in the same worktree
- instructions to keep working until verified
- instructions to report file overlap or blocking questions explicitly

When the task group and worktree group collapse to the same participant set,
the parent treats it as one group chat. When they differ, the task room is for
goal-level coordination and the worktree room is for file-conflict
coordination.

Current implementation threads these keys into task prompts and session
metadata, derives stable runtime room IDs, and best-effort creates task and
worktree group rooms with the parent, owner, and sub-agent as participants.
The next hardening step is to route `AGENT_COORDINATION` lines as first-class
messages into those rooms instead of relying on terminal-event narration.

## Parent Contact Actions

Workers should not directly message the owner. They should emit one of:

- `QUESTION_FOR_TASK_CREATOR: ...`
- `AGENT_COORDINATION: ...`
- `USE_SKILL parent-agent {"request":"..."}`

The parent agent owns delivery to the originating channel, confirmation flow,
and any wait-for-human behavior.

## Benchmark Loop

The repo now has a command-matrix scaffold at
`packages/benchmarks/orchestrator/code_agent_matrix.py`. It wraps the existing
SWE-bench and Terminal-Bench runners, records a separate artifact directory per
`(benchmark, adapter)` cell, and writes `summary.json` plus `summary.md` with
failure-class counts. It does not require external services for dry-run or
artifact summarization tests.

Dry-run the default `elizaos` vs `opencode` plan:

```bash
PYTHONPATH=packages python -m benchmarks.orchestrator.code_agent_matrix \
  --dry-run \
  --no-docker \
  --smoke \
  --max-tasks 1
```

Run a smoke comparison against local sample tasks where supported:

```bash
CEREBRAS_API_KEY=... \
PYTHONPATH=packages python -m benchmarks.orchestrator.code_agent_matrix \
  --adapters elizaos,opencode \
  --benchmarks swe_bench,terminal_bench \
  --provider cerebras \
  --model gpt-oss-120b \
  --smoke \
  --no-docker \
  --max-tasks 1
```

Run a real first pass:

```bash
CEREBRAS_API_KEY=... \
PYTHONPATH=packages python -m benchmarks.orchestrator.code_agent_matrix \
  --adapters elizaos,opencode \
  --benchmarks swe_bench,terminal_bench \
  --provider cerebras \
  --model gpt-oss-120b \
  --max-tasks 10
```

Summarize an existing run without rerunning agents:

```bash
PYTHONPATH=packages python -m benchmarks.orchestrator.code_agent_matrix \
  --summarize benchmark_results/code-agent-matrix/<run-id>
```

The harness recognizes command-template overrides for adapter-specific
experiments:

- `CODE_AGENT_BENCH_ELIZAOS_SWE_BENCH_CMD`
- `CODE_AGENT_BENCH_OPENCODE_SWE_BENCH_CMD`
- `CODE_AGENT_BENCH_ELIZAOS_TERMINAL_BENCH_CMD`
- `CODE_AGENT_BENCH_OPENCODE_TERMINAL_BENCH_CMD`

Templates can use `{adapter}`, `{benchmark}`, `{provider}`, `{model}`,
`{outputDir}`, `{trajectoryDir}`, and `{workspaceRoot}`. Keep provider keys in
environment variables only. Expected secret env names include `CEREBRAS_API_KEY`,
`OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`; do not place their values in command
templates, profile JSON, docs, or trajectories.

Iterative grind:

1. Run single `elizaos` worker on SWE-bench with `gpt-oss-120b`.
2. Compare against vendored `opencode` on the same model/provider.
3. Read failed trajectories and classify misses:
   - wrong file localization
   - patch failed to apply
   - insufficient tests
   - stopped early
   - asked user instead of inspecting
   - tool bloat or wrong tool choice
4. Convert repeated misses into prompt/tool-policy changes or focused actions.
5. Repeat until `elizaos` is consistently ahead of `opencode`.
6. Run the same loop on Terminal-Bench.
7. Repeat for the orchestrating elizaOS agent with focused code actions plus
   sub-agent orchestration.

Secrets, including provider API keys, must stay in runtime config or the
operator environment and must not be written into repo files or trajectories.

## Trajectory Review Cadence

For each matrix run, review in this order:

1. `summary.md` for failure-class movement by adapter.
2. Per-cell `command.json` to confirm the provider/model/task-agent labels were
   what the run intended.
3. Per-cell benchmark result JSON for pass/fail and task IDs.
4. Per-cell `stdout.log` / `stderr.log` for harness failures, provider failures,
   and missing-tool failures.
5. `trajectories/` and benchmark trace files for action-level misses.

Convert repeated misses into one small change at a time:

- prompt/system-policy change when the agent had the right tools but chose the
  wrong behavior
- tool-surface change when the agent repeatedly needed a missing primitive
- harness change when the benchmark did not capture enough output to diagnose
- swarm-routing change when failures are coordination or file-overlap related

After each change, rerun the same slice before increasing `--max-tasks`, then
promote the slice from SWE-bench smoke, to SWE-bench real, to Terminal-Bench
smoke, to Terminal-Bench real. The success criterion is stable improvement over
`opencode` on the same cases and model, not a one-off lucky pass.
