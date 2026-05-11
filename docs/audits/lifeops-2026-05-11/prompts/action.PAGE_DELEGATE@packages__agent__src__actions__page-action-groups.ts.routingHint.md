# `action.PAGE_DELEGATE@packages/agent/src/actions/page-action-groups.ts.routingHint`

- **Kind**: routing-hint
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/page-action-groups.ts:206`
- **Token count**: 56
- **Last optimized**: never
- **Action**: PAGE_DELEGATE

## Current text
```
main-chat browser/wallet/settings/page operations -> PAGE_DELEGATE; browser navigation uses {page:"browser", action:"BROWSER_OPEN", url} or {page:"browser", action:"BROWSER", subaction:"open", url} through the browser page
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
