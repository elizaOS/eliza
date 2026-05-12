# `action.RUNTIME@packages/agent/src/actions/runtime.ts.param.module.description`

- **Kind**: action-parameter
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/runtime.ts:406`
- **Token count**: 37
- **Last optimized**: never
- **Action**: RUNTIME
- **Parameter**: module (required: no)

## Current text
```
self_status only: which module to inspect (all, runtime, permissions, wallet, provider, pluginHealth, connectors, cloud, features). Default: all.
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
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
