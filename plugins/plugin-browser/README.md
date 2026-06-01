# @elizaos/plugin-browser

Browser automation and companion bridge plugin for elizaOS. Adds the `BROWSER` action and `MANAGE_BROWSER_BRIDGE` action to any Eliza agent, owns the Eliza browser workspace (electrobun-embedded `BrowserView` on desktop, JSDOM fallback on web/mobile), and manages the Chrome/Safari Agent Browser Bridge companion extension.

## What this plugin provides

### Actions

**BROWSER** — Controls a registered browser target. The agent picks the best available backend automatically, or you can pin a specific target with the `target` parameter. Supported operations:

| `action` value | What it does |
|---|---|
| `open` | Open a URL in a new tab |
| `navigate` | Navigate an existing tab to a URL |
| `click` | Click a DOM element by CSS selector |
| `type` | Type text into a selector |
| `press` | Press a keyboard key |
| `get` | Get a DOM value |
| `state` | Return current tab state (URL, title) |
| `snapshot` | Capture a DOM snapshot |
| `screenshot` | Capture a screenshot |
| `reload` | Reload the current tab |
| `back` / `forward` | Browser history navigation |
| `close` | Close a tab |
| `show` / `hide` | Show or hide the browser window |
| `wait` | Wait for a selector to appear |
| `tab` | Tab management (list/new/close/switch) |
| `realistic_click` | Animated cursor click (visible to user) |
| `realistic_fill` | Animated fill with per-character delay |
| `realistic_type` | Animated typing |
| `realistic_press` | Animated key press |
| `cursor_move` | Animate cursor to a position |
| `cursor_hide` | Hide the cursor overlay |
| `autofill_login` | Fill saved credentials into a browser tab (vault-gated; requires `domain`) |

**MANAGE_BROWSER_BRIDGE** — Manages the Chrome/Safari companion extension. Subactions: `install` (build + reveal + open manager), `reveal_folder` (open the build folder in Finder/Explorer), `open_manager` (`chrome://extensions`), `refresh` (report paired companions and settings). Owner-only.

### Browser targets

The plugin uses a pluggable target registry in `BrowserService`. Targets are selected automatically by availability and score:

| Target ID | Backend | When available |
|---|---|---|
| `workspace` | Electrobun `BrowserView` (desktop) or JSDOM (web) | Always |
| `bridge` | Paired Chrome/Safari via companion extension | At least one companion paired |
| `stagehand` | Playwright/Stagehand via HTTP endpoint | `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` or `STAGEHAND_SERVER_URL` set |

External plugins can register additional targets by calling `BrowserService.registerTarget(target)`.

### Provider

`browser_workspace` — Injects the current dispatch mode (`desktop` / `web`) and a capped list of open tabs into agent context. Active when the `browser` or `web` context is selected.

### Routes

`/api/browser-bridge/*` — HTTP surface for the companion extension: pairing, settings, tab sync, page-context ingest, session progress, and extension package build/download.

## Requirements

### Auto-enable

The plugin is opt-in. It activates when `config.features.browser` is truthy in the elizaOS agent config:

```json
{
  "features": {
    "browser": true
  }
}
```

### Environment variables

| Variable | Purpose |
|---|---|
| `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` | Full URL for the Stagehand command endpoint |
| `STAGEHAND_SERVER_URL` | Stagehand base URL (commands go to `<url>/api/browser-command`) |
| `ELIZA_BROWSER_STAGEHAND_URL` | Alias for `STAGEHAND_SERVER_URL` |
| `ELIZA_BROWSER_STAGEHAND_AUTO_SETUP` | Set `false` to disable automatic stagehand-server install/build |
| `ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE` | Set `true` to allow stagehand target on mobile |
| `ELIZA_MOBILE_PLATFORM` / `ELIZA_PLATFORM` / `CAPACITOR_PLATFORM` | Platform hint for target scoring (`ios`/`android`/`mobile`) |

### Vault keys (set by the user, not env vars)

`autofill_login` only fires when the user has pre-authorized it per domain:

- `creds.<domain>.:autoallow = "1"` — set via Settings → Vault → Logins.

Without this flag, the action returns an error rather than prompting interactively.

## Companion extension authentication

Companion-scoped endpoints require two headers:

```
X-Browser-Bridge-Companion-Id: <companion uuid>
Authorization: Bearer <pairing token>
```

Legacy header aliases (`X-LifeOps-Browser-Companion-Id`, `x-eliza-browser-companion-id`) are not accepted.

## Database

Drizzle tables in the `browser` PostgreSQL schema (applied by elizaOS `plugin-sql` migrator):

- `browser_bridge_companions`
- `browser_bridge_settings`
- `browser_bridge_tabs`
- `browser_bridge_page_contexts`

## Registering a custom browser target

Any plugin can extend the browser dispatch surface at runtime:

```ts
import { BrowserService, BROWSER_SERVICE_TYPE } from "@elizaos/plugin-browser";
import type { BrowserTarget } from "@elizaos/plugin-browser";

const myTarget: BrowserTarget = {
  id: "my-target",
  name: "My Browser",
  description: "Custom browser backend.",
  kind: "external",
  priority: 50,
  available: async () => true,
  execute: async (command) => { /* ... */ },
};

const browserService = runtime.getService<BrowserService>(BROWSER_SERVICE_TYPE);
browserService?.registerTarget(myTarget);
```
