# `action.REMOTE_DESKTOP@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 24
- **Last optimized**: never
- **Action**: REMOTE_DESKTOP
- **Similes**: REMOTE_SESSION, VNC_SESSION, REMOTE_CONTROL, PHONE_REMOTE_ACCESS, CONNECT_FROM_PHONE

## Current text
```
Manage remote-desktop sessions so the owner can connect to this machine from another device. 
```

## Compressed variant
```
remote-desktop sessions: start|status|end|list|revoke; start requires confirmed:true (+ pairing code in cloud mode)
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
