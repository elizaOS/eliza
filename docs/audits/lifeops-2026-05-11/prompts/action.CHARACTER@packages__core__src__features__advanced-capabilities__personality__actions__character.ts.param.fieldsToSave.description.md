# `action.CHARACTER@packages/core/src/features/advanced-capabilities/personality/actions/character.ts.param.fieldsToSave.description`

- **Kind**: action-parameter
- **Owner**: packages/core
- **File**: `packages/core/src/features/advanced-capabilities/personality/actions/character.ts:84`
- **Token count**: 62
- **Last optimized**: never
- **Action**: CHARACTER
- **Parameter**: fieldsToSave (required: no)

## Current text
```
persist: optional list of character fields to persist. Allowed values: name, username, system, bio, adjectives, topics, style, messageExamples, postExamples, templates, settings, plugins, documents. Omit to persist all populated saveable fields.
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
