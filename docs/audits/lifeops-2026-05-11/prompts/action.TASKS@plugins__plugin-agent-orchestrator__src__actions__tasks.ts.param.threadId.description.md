# `action.TASKS@plugins/plugin-agent-orchestrator/src/actions/tasks.ts.param.threadId.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-agent-orchestrator
- **File**: `plugins/plugin-agent-orchestrator/src/actions/tasks.ts:2050`
- **Token count**: 27
- **Last optimized**: never
- **Action**: TASKS
- **Parameter**: threadId (required: no)

## Current text
```
Target task-thread id for action=cancel / action=control / action=share / action=archive / action=reopen.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
