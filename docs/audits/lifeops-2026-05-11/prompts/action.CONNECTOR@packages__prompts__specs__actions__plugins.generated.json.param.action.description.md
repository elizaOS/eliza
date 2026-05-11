# `action.CONNECTOR@packages/prompts/specs/actions/plugins.generated.json.param.action.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 91
- **Last optimized**: never
- **Action**: CONNECTOR
- **Parameter**: action (required: no)

## Current text
```
Lifecycle operation. connect (start auth/pairing); disconnect (revoke + clear grant); verify (active read/send probe where available). status/list are read-only diagnostics for explicit troubleshooting; prefer provider/core registry context when available. Strongly preferred - when omitted, the handler runs an LLM extraction over the conversation to recover it.
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
