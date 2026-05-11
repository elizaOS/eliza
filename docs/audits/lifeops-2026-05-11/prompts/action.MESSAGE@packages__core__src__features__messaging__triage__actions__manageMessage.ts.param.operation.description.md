# `action.MESSAGE@packages/core/src/features/messaging/triage/actions/manageMessage.ts.param.operation.description`

- **Kind**: action-parameter
- **Owner**: packages/core
- **File**: `packages/core/src/features/messaging/triage/actions/manageMessage.ts:36`
- **Token count**: 32
- **Last optimized**: never
- **Action**: MESSAGE
- **Parameter**: operation (required: yes)

## Current text
```
Operation to apply: archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.
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
