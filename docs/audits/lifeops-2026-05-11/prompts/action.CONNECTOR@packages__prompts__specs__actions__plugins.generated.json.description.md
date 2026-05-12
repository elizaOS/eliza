# `action.CONNECTOR@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 18
- **Last optimized**: never
- **Action**: CONNECTOR
- **Similes**: CONNECT_GOOGLE, CONNECT_TELEGRAM, CONNECT_DISCORD, DISCONNECT_SERVICE, CHECK_CONNECTION, SERVICE_STATUS, NOTIFICATION_RESOLVE_ENDPOINTS

## Current text
```
Manage **account** state for installed connectors: connect (log in), 
```

## Compressed variant
```
account-level connector lifecycle: connect(log in)|disconnect(log out)|verify|status|list; registry-driven kinds; for plugin install/uninstall use PLUGIN
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
