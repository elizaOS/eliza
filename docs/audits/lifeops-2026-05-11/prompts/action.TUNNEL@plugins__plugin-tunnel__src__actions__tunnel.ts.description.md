# `action.TUNNEL@plugins/plugin-tunnel/src/actions/tunnel.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-tunnel
- **File**: `plugins/plugin-tunnel/src/actions/tunnel.ts:93`
- **Token count**: 67
- **Last optimized**: never
- **Action**: TUNNEL
- **Similes**: TAILSCALE, START_TAILSCALE, STOP_TAILSCALE, GET_TAILSCALE_STATUS, START_TUNNEL, OPEN_TUNNEL, CREATE_TUNNEL, TAILSCALE_UP, STOP_TUNNEL, CLOSE_TUNNEL, TAILSCALE_DOWN, TAILSCALE_STATUS, CHECK_TUNNEL, TUNNEL_INFO, TUNNEL_STATUS

## Current text
```
Tunnel operations dispatched by `action`: start, stop, status. The `start` action accepts an optional `port` (defaults to 3000); `stop` and `status` take no parameters. Backed by whichever tunnel plugin is active (local Tailscale CLI, Eliza Cloud headscale, or ngrok).
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
