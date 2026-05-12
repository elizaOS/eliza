# `action.VISION@plugins/plugin-vision/src/action.ts.param.targetHint.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-vision
- **File**: `plugins/plugin-vision/src/action.ts:1290`
- **Token count**: 28
- **Last optimized**: never
- **Action**: VISION
- **Parameter**: targetHint (required: no)

## Current text
```
For action=name_entity or action=identify_person: optional phrase describing which visible entity to focus on.
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
