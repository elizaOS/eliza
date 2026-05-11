# `action.PAGE_DELEGATE@packages/agent/src/actions/page-action-groups.ts.param.page.description`

- **Kind**: action-parameter
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/page-action-groups.ts:182`
- **Token count**: 20
- **Last optimized**: never
- **Action**: PAGE_DELEGATE
- **Parameter**: page (required: yes)

## Current text
```
Page context to dispatch under. Selects the allowed child-action context set.
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
