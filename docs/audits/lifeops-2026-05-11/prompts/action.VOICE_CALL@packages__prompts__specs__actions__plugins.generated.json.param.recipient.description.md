# `action.VOICE_CALL@packages/prompts/specs/actions/plugins.generated.json.param.recipient.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 27
- **Last optimized**: never
- **Action**: VOICE_CALL
- **Parameter**: recipient (required: no)

## Current text
```
For recipientKind=external: contact name or E.164 phone number. Names resolve via the relationships store.
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
