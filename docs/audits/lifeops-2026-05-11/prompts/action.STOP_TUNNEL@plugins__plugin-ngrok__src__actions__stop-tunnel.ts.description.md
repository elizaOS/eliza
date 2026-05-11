# `action.STOP_TUNNEL@plugins/plugin-ngrok/src/actions/stop-tunnel.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-ngrok
- **File**: `plugins/plugin-ngrok/src/actions/stop-tunnel.ts:15`
- **Token count**: 49
- **Last optimized**: never
- **Action**: STOP_TUNNEL
- **Similes**: CLOSE_TUNNEL, SHUTDOWN_TUNNEL, NGROK_STOP, TUNNEL_DOWN

## Current text
```
Stop the running ngrok tunnel and clean up resources. Can be chained with START_TUNNEL actions for tunnel rotation workflows or combined with deployment actions for automated service management.
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
