# `action.FILE@plugins/plugin-coding-tools/src/actions/file.ts.param.ignore.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-coding-tools
- **File**: `plugins/plugin-coding-tools/src/actions/file.ts:64`
- **Token count**: 10
- **Last optimized**: never
- **Action**: FILE
- **Parameter**: ignore (required: no)

## Current text
```
For action=ls, glob patterns to exclude.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 172
- Success rate: 0.98
- Avg input chars when matched: 99145

## Sample failure transcripts
- traj `tj-e554e982e8c881` scenario `unknown` status=errored stage=planner
  - user: `Find any unread emails from security@example.test that were received today

BENCHMARK CONTEXT (authoritative):
{
  "benchmark": "lifeops_bench",
  "task_id": "lifeops-7e6ea0480542",
  "tools": [
    {…`
- traj `tj-e554e982e8c881` scenario `unknown` status=errored stage=planner
  - user: `Find any unread emails from security@example.test that were received today

BENCHMARK CONTEXT (authoritative):
{
  "benchmark": "lifeops_bench",
  "task_id": "lifeops-7e6ea0480542",
  "tools": [
    {…`
- traj `tj-e554e982e8c881` scenario `unknown` status=errored stage=planner
  - user: `Find any unread emails from security@example.test that were received today

BENCHMARK CONTEXT (authoritative):
{
  "benchmark": "lifeops_bench",
  "task_id": "lifeops-7e6ea0480542",
  "tools": [
    {…`

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
