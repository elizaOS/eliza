# `action.TASKS@plugins/plugin-agent-orchestrator/src/actions/sandbox-stub.ts.param.labels.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-agent-orchestrator
- **File**: `plugins/plugin-agent-orchestrator/src/actions/sandbox-stub.ts:44`
- **Token count**: 26
- **Last optimized**: never
- **Action**: TASKS
- **Parameter**: labels (required: no)

## Current text
```
Labels (csv string or array) for action=manage_issues with issueAction=create|update|add_labels|list.
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
