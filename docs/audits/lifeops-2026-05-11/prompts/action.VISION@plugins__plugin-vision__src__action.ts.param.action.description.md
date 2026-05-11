# `action.VISION@plugins/plugin-vision/src/action.ts.param.action.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-vision
- **File**: `plugins/plugin-vision/src/action.ts:1290`
- **Token count**: 35
- **Last optimized**: never
- **Action**: VISION
- **Parameter**: action (required: no)

## Current text
```
Operation to perform: describe, capture, set_mode, name_entity, identify_person, or track_entity. Inferred from message text when omitted.
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
