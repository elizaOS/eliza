# `action.CREDENTIALS@packages/prompts/specs/actions/plugins.generated.json.param.action.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 30
- **Last optimized**: never
- **Action**: CREDENTIALS
- **Parameter**: action (required: yes)

## Current text
```
fill | whitelist_add | whitelist_list (autofill) | search | list | inject_username | inject_password (password manager).
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 3
- Success rate: 1.00
- Avg input chars when matched: 88296

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
