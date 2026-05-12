# `action.BLOCK@packages/prompts/specs/actions/plugins.generated.json.param.durationMinutes.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 27
- **Last optimized**: never
- **Action**: BLOCK
- **Parameter**: durationMinutes (required: no)

## Current text
```
How long to block, in minutes. Omit/null for an indefinite block that stays active until manually removed.
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 16
- Success rate: 1.00
- Avg input chars when matched: 82273

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
