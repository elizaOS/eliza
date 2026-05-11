# `action.MEMORY@packages/agent/src/actions/memories.ts.param.query.description`

- **Kind**: action-parameter
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/memories.ts:308`
- **Token count**: 15
- **Last optimized**: never
- **Action**: MEMORY
- **Parameter**: query (required: no)

## Current text
```
search: case-insensitive text match against memory content.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 204
- Success rate: 0.98
- Avg input chars when matched: 99404

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
