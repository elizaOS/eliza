# `action.TAILSCALE@plugins/plugin-tailscale/src/actions/tailscale.ts.param.accountId.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-tailscale
- **File**: `plugins/plugin-tailscale/src/actions/tailscale.ts:272`
- **Token count**: 29
- **Last optimized**: never
- **Action**: TAILSCALE
- **Parameter**: accountId (required: no)

## Current text
```
Optional Tailscale account id from TAILSCALE_ACCOUNTS. Defaults to TAILSCALE_DEFAULT_ACCOUNT_ID or legacy settings.
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
