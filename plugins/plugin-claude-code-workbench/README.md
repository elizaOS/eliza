# @eliza/plugin-claude-code-workbench

Claude Code companion plugin for Eliza/ElizaOS.

This plugin provides an allowlisted, policy-controlled workflow runner for this repository so agents can execute common quality/build/test/review tasks safely.

## What it adds

- **Service**: `claude_code_workbench` (`ClaudeCodeWorkbenchService`)
- **Actions**:
  - `CLAUDE_CODE_WORKBENCH_RUN`
  - `CLAUDE_CODE_WORKBENCH_LIST`
- **Provider**: `CLAUDE_CODE_WORKBENCH_STATUS`
- **Routes**:
  - `GET /claude-code-workbench/status`
  - `GET /claude-code-workbench/workflows`
  - `POST /claude-code-workbench/run`

## Default workflows

Includes repo-specific workflows such as:

- `repo_status`, `repo_diff_stat`, `recent_commits`
- `check`, `typecheck`, `lint`
- `test_once`, `test_e2e`
- `pre_review_local`
- `build_local_plugins`, `build`, `docs_build`
- `format_fix`, `lint_fix` (mutating; disabled by default)

## Configuration

Set via plugin config or environment variables:

- `CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT` (default: process cwd)
- `CLAUDE_CODE_WORKBENCH_TIMEOUT_MS` (default: `600000`)
- `CLAUDE_CODE_WORKBENCH_MAX_OUTPUT_CHARS` (default: `120000`)
- `CLAUDE_CODE_WORKBENCH_MAX_STDIN_BYTES` (default: `65536`)
- `CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS` (default: `*`)
- `CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS` (default: `false`)

## Action usage

You can invoke through options or natural text:

- `workbench run check`
- `ccw pre_review_local`

## Security model

- Uses `spawn` with `shell: false`
- Enforces workflow allowlist
- Enforces workspace-root cwd boundaries
- Enforces timeout and output caps
- Serializes runs to avoid overlapping command execution
- Mutating workflows require explicit opt-in

## Claude Code construction notes

Claude Code extension points are primarily MCP servers, hooks, custom slash commands, settings/policies, and subagents. This plugin is designed as a runtime-side companion that can back those extension points with deterministic repository workflows.
