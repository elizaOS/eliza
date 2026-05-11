# `action.BLOCK@packages/prompts/specs/actions/plugins.generated.json.param.includeLiveStatus.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 28
- **Last optimized**: never
- **Action**: BLOCK
- **Parameter**: includeLiveStatus (required: no)

## Current text
```
(target=website, action=list_active) Include the current hosts-file/SelfControl live block state. Default true.
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
