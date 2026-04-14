# @elizaos/app-browser

Milady **app-browser** slice: agent plugin for the desktop-owned browser workspace plus Steward wallet actions. Naming matches other app packages (for example `@elizaos/app-lifeops`).

## What this slice does

- Opens browser tabs as hidden background `BrowserWindow`s in Electrobun
- Keeps tabs alive while their view is closed
- Lets an Eliza agent list, open, navigate, show, hide, close, snapshot, and evaluate tabs
- Uses a loopback-only HTTP bridge with bearer auth between the desktop shell and the embedded agent runtime

## Isolation vs `eliza/packages/app-core`

- **Native shell** (real windows, preload, bridge server) stays in `apps/app/electrobun/` — that code cannot run inside the plugin package.
- **Dashboard UI** for the browser workspace should live in this package (or be re-exported from here) once wired, and `app-core` should import it. Moving the **entire** `app-core` tree into this package would duplicate the Milady UI shell; the intended split is **browser-specific** surfaces here, thin imports in `app-core`.
- **Agent/runtime** pieces stay as they are: `@elizaos/agent` services (`browser-workspace`, Steward) plus this plugin’s actions, providers, and service.

## What it does not do yet

- Inject a production dapp wallet provider into arbitrary websites
- Ship the full browser management UI from `app-core` (planned consolidation above)
- Expose rich multi-tab visuals beyond native show/hide windows

## Why not an iframe

- Cross-origin iframes do not give the agent full browser control
- Wallet injection for external sites needs a privileged webview/preload boundary
- Background persistence and tab/session storage belong in the desktop shell, not in the Milady app frame
