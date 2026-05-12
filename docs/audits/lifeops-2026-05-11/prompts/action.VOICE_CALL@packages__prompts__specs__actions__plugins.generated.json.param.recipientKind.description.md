# `action.VOICE_CALL@packages/prompts/specs/actions/plugins.generated.json.param.recipientKind.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 51
- **Last optimized**: never
- **Action**: VOICE_CALL
- **Parameter**: recipientKind (required: yes)

## Current text
```
Recipient discriminator: `owner` (escalation; uses owner number env), `external` (third party; recipient name resolved via relationships, allow-list checked), or `e164` (raw E.164 phone in `phoneNumber`).
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
