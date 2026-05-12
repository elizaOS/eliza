# `action.PLUGIN@packages/agent/src/actions/plugin.ts.description`

- **Kind**: action-description
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/plugin.ts:793`
- **Token count**: 198
- **Last optimized**: never
- **Action**: PLUGIN
- **Similes**: INSTALL_PLUGIN, UNINSTALL_PLUGIN, UPDATE_PLUGIN, SYNC_PLUGIN, EJECT_PLUGIN, REINJECT_PLUGIN, CONFIGURE_PLUGIN, READ_PLUGIN_CONFIG, TOGGLE_PLUGIN, CONFIGURE_CONNECTOR, SAVE_CONNECTOR_CONFIG, SET_CONNECTOR_ENABLED, TOGGLE_CONNECTOR, DISCONNECT_CONNECTOR, LIST_CONNECTORS, CONNECTOR, PLUGIN_LIFECYCLE, MANAGE_PLUGIN, MANAGE_CONNECTOR

## Current text
```
Install / uninstall / configure / eject plugins and connectors at the **package** level. ops: install, uninstall, update (refresh to latest), sync (pull upstream into ejected source), eject (clone source locally), reinject (drop ejected copy and use npm), configure (save key/value config + auto-test), read_config (return current state), toggle (enable/disable), list (enumerate plugins or connectors with optional filter), disconnect (sign out connector and drop session). type='plugin' (default) targets installed plugins; type='connector' targets plugins in the 'connector' category and manages their **package** install/eject only, not account state. For **account**-level connector lifecycle (log in, log out, verify account, list account status), use the `CONNECTOR` action instead.
```

## Compressed variant
```
package-level plugin+connector lifecycle install uninstall update sync eject reinject configure read_config toggle list disconnect type=plugin|connector; for account login/logout use CONNECTOR
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (192 chars vs 789 chars — 76% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
