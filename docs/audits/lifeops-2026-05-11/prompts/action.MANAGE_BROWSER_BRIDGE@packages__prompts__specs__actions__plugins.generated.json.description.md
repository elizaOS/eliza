# `action.MANAGE_BROWSER_BRIDGE@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 166
- **Last optimized**: never
- **Action**: MANAGE_BROWSER_BRIDGE
- **Similes**: INSTALL_BROWSER_BRIDGE, SETUP_BROWSER_BRIDGE, PAIR_BROWSER, CONNECT_BROWSER, ADD_BROWSER_EXTENSION, REVEAL_BROWSER_BRIDGE_FOLDER, OPEN_BROWSER_BRIDGE_FOLDER, SHOW_BROWSER_EXTENSION_FOLDER, OPEN_CHROME_EXTENSIONS, OPEN_BROWSER_BRIDGE_MANAGER, OPEN_EXTENSION_MANAGER, REFRESH_BROWSER_BRIDGE, REFRESH_BROWSER_BRIDGE_CONNECTION, RELOAD_BROWSER_BRIDGE_STATUS, RECONNECT_BROWSER, MANAGE_CHROME_EXTENSION, MANAGE_SAFARI_EXTENSION, BROWSER_BRIDGE_INSTALL, BROWSER_BRIDGE_REVEAL_FOLDER, BROWSER_BRIDGE_OPEN_MANAGER, BROWSER_BRIDGE_REFRESH

## Current text
```
Owner-only management of the Agent Browser Bridge companion extension that connects Eliza to the user's Chrome and Safari browsers. Actions: refresh (show settings/status/connection state), install (build and reveal the extension for setup), reveal_folder (open the built extension folder), open_manager (open chrome://extensions only when the owner explicitly asks). The action parameter is inferred from message text when omitted; show/settings/status maps to refresh and 'open chrome extensions' maps to open_manager. Prefer the browser-bridge provider for passive companion status and use this action's refresh child action only for an explicit live refresh.
```

## Compressed variant
```
Manage LifeOps Browser Bridge: refresh shows settings/status; install setup; reveal_folder build folder; open_manager chrome://extensions.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (138 chars vs 662 chars — 79% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
