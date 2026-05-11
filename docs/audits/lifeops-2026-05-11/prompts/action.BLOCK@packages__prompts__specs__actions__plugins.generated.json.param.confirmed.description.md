# `action.BLOCK@packages/prompts/specs/actions/plugins.generated.json.param.confirmed.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 40
- **Last optimized**: never
- **Action**: BLOCK
- **Parameter**: confirmed (required: no)

## Current text
```
(target=website) Set true only when the owner has explicitly confirmed the block. Without it, block returns a draft confirmation request. Required by release.
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
