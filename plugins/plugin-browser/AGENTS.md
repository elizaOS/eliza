# @elizaos/plugin-browser

Adds browser workspace automation to an Eliza agent.

## Purpose / role

Owns the Eliza browser workspace (electrobun-embedded `BrowserView` on desktop, JSDOM fallback on web/mobile). Loaded by the elizaOS runtime via the `browserPlugin` export. Auto-enabled when `config.features.browser` is truthy (checked by `auto-enable.ts`); disabled by default unless that config key is set.

## Plugin surface

### Actions

- **BROWSER** (`src/actions/browser.ts`) — Core browser control. Dispatches to the active `BrowserService` target. Subactions: `open`, `navigate`, `click`, `type`, `fill`, `clear`, `press`, `scroll`, `scroll_into`, `hover`, `drag`, `get`, `state`, `snapshot`, `screenshot`, `reload`, `back`, `forward`, `close`, `show`, `hide`, `wait`, `wait_for_url`, `tab`, `realistic-click`, `realistic-fill`, `realistic-type`, `realistic-press`, `cursor-move`, `cursor-hide`, `autofill_login`. Role-gated OWNER only. `wait_for_url` (pure predicate + poll loop in `src/actions/wait-for-url*.ts`) optionally opens a `url`, then polls the current tab URL against a `pattern` (substring, or a `/regex/` literal — invalid regex falls back to substring), streaming a `HandlerCallback` status each poll and resolving with a typed match/timeout result (never throws on timeout). Tunables: `timeoutMs` (default 300000) and `pollIntervalMs` (default 2000).

### Providers

- **browser_workspace** (`src/providers/workspace.ts`) — Injects live workspace mode (`desktop` / `web`) and the complete open tab list into agent context. Active when `browser` or `web` context is selected.

### Services

- **BrowserService** (`src/browser-service.ts`) — Pluggable target registry. Built-in targets: `workspace` (always registered), `stagehand` (registered when any stagehand URL env var is configured and the target is not disabled). External plugins register additional targets via `BrowserService.registerTarget(target)`. Service type constant: `BROWSER_SERVICE_TYPE = "browser"`.
- **Browser bridge policy** (`src/bridge-policy.ts`) — Pure token TTL / expiry, focus-window, and URL-domain helpers shared by host plugins.
- **Browser domain policy** (`src/browser-domain-policy.ts`) — Per-domain command policy hooks (issue #19882). Host plugins register `BrowserDomainPolicy` implementations via `registerBrowserDomainPolicy`; the `BrowserService` dispatcher evaluates every command (including nested batch steps) before target selection, and the JSDOM workspace path re-evaluates at every *resolved* URL — the form's resolved submit action, an anchor's resolved `href`, and each redirect hop (taken manually, so a 307/308 cannot hand the form body to a denied domain after the pre-flight check). Evaluation fails closed: a throwing or malformed policy blocks, and the built-in `createBrowserDomainAllowlistPolicy` blocks gated effects on unknown domains. With no policies registered, dispatch behavior is unchanged; the generic eval/upload hard block is independent of policy registration.
- **Browser bridge readiness** (`src/bridge-readiness.ts`) — Pure companion recency, permission, pause, and readiness-state policy used by host plugins and UI surfaces that summarize bridge setup.
- **Browser bridge records** (`src/bridge-records.ts`) — Constructors for companion, tab, and page-context domain records. Host plugins persist records but should not redefine their shape/defaults.

### Routes

Workspace setup and automation routes live in `src/routes/workspace-setup.ts`
and `src/routes/workspace.ts`. The companion extension and its HTTP routes,
packaging, native messaging host, and runtime target are retired.

Legacy record contracts remain available for existing LifeOps stored data;
they do not provide extension enrollment or execution.

## Layout

```
src/
  index.ts                         Public barrel (re-exports + bundle-safety guard)
  plugin.ts                        browserPlugin export — actions, services, providers, routes, schema, autoEnable
  browser-service.ts               BrowserService + BrowserTarget interface + BROWSER_SERVICE_TYPE
  bridge-policy.ts                 Browser bridge token TTL / expiry, focus-window, and URL-domain helpers
  browser-domain-policy.ts         Per-domain command policy hooks + fail-closed allowlist policy (#19882)
  bridge-readiness.ts              Browser bridge readiness / permission policy helpers
  bridge-records.ts                Browser bridge companion/tab/page-context record constructors
  password-manager-bridge.ts       Dual-backend (1Password CLI / ProtonPass CLI) credential injection bridge
  schema.ts                        Drizzle tables
  contracts.ts                     BrowserBridge* shared types (companions, settings, tabs, sessions)
  lifeops-session-contracts.ts     LifeOps browser session types
  workspace.ts                     Workspace-level re-exports
  browser-capture-hooks.ts         BrowserCaptureHooks interface + global registration helpers
  browser-workspace-hooks.ts       BrowserWorkspaceHooks interface + global registration helpers
  actions/
    browser.ts                     BROWSER action
    browser-autofill-login.ts      autofill_login subaction (vault-gated)
    wait-for-url-predicate.ts      Pure URL-match predicate (substring + /regex/)
    wait-for-url.ts                wait_for_url poll loop (injectable clock/sleep/url source)
  providers/
    workspace.ts                   browser_workspace provider
  routes/
    workspace-setup.ts             Workspace setup routes
    workspace.ts                   Workspace routes
    workspace-account-gate.ts      Account gate middleware
  parity/
    browser-matrix.ts              Machine-checkable BROWSER action parity matrix (#9476)
    index.ts                       Parity tooling barrel
  targets/
    stagehand-target.ts            `stagehand` BrowserTarget — Playwright/Stagehand fallback
  workspace/
    browser-workspace.ts           Public API surface and main command router (executeBrowserWorkspaceCommand)
    browser-workspace-types.ts     All workspace types and interfaces
    browser-workspace-state.ts     Mutable tab/session state
    browser-workspace-errors.ts    Structured workspace error codes
    browser-workspace-helpers.ts   Utilities and command normalization
    browser-workspace-desktop.ts   Desktop bridge HTTP client
    browser-workspace-jsdom.ts     JSDOM document loading and DOM setup
    browser-workspace-elements.ts  Element finding and selector parsing
    browser-workspace-forms.ts     Form interaction helpers
    browser-workspace-network.ts   Network interception and HAR
    browser-workspace-snapshots.ts Snapshots, diffs, screenshots
    browser-workspace-web.ts       Web-mode command execution
    browser-capture.ts             Frame capture loop (startBrowserCapture/stopBrowserCapture)
    index.ts                       Workspace barrel
auto-enable.ts                     Standalone shouldEnable check (no transitive plugin imports)
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-browser clean                           # remove build output
bun run --cwd plugins/plugin-browser build                           # build package artifacts
bun run --cwd plugins/plugin-browser build:js                        # js build lane
bun run --cwd plugins/plugin-browser build:types                     # types build lane
bun run --cwd plugins/plugin-browser typecheck                       # TypeScript typecheck
bun run --cwd plugins/plugin-browser lint                            # mutating Biome check
bun run --cwd plugins/plugin-browser lint:check                      # read-only Biome check
bun run --cwd plugins/plugin-browser format                          # write formatting
bun run --cwd plugins/plugin-browser format:check                    # read-only formatting check
bun run --cwd plugins/plugin-browser test                            # run package tests
```

## Config / env vars

| Variable | Required | Purpose |
|---|---|---|
| `ELIZA_BROWSER_STAGEHAND_COMMAND_URL` | no | Full URL to the Stagehand command endpoint; activates the `stagehand` target |
| `STAGEHAND_BROWSER_COMMAND_URL` | no | Alias for the stagehand command URL |
| `ELIZA_STAGEHAND_COMMAND_URL` | no | Alias for the stagehand command URL |
| `STAGEHAND_SERVER_URL` | no | Base URL for Stagehand; commands go to `<url>/api/browser-command` |
| `ELIZA_BROWSER_STAGEHAND_URL` | no | Alias for `STAGEHAND_SERVER_URL` |
| `ELIZA_STAGEHAND_SERVER_URL` | no | Alias for `STAGEHAND_SERVER_URL` |
| `ELIZA_BROWSER_STAGEHAND_ENABLED` | no | Set to a falsy value to disable the stagehand target entirely |
| `ELIZA_BROWSER_STAGEHAND_AUTO_SETUP` | no | Set `false` to disable automatic `bun install` + build for the stagehand-server dir |
| `ELIZA_BROWSER_STAGEHAND_HEALTH_URL` | no | Health-check URL for the stagehand server |
| `ELIZA_BROWSER_STAGEHAND_DIR` | no | Custom path to the stagehand-server directory |
| `ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE` | no | Set `true` to allow stagehand target on mobile runtimes |
| `ELIZA_MOBILE_PLATFORM` / `ELIZA_PLATFORM` / `CAPACITOR_PLATFORM` | no | Platform hint (`ios`/`android`/`mobile`) — changes target scoring |

Autofill-login vault keys (set by user via Settings → Vault → Logins, not env vars):
- `creds.<domain>.:autoallow = "1"` — enables agent autofill for that domain.

Plugin activation: `config.features.browser` must be truthy (object with `enabled !== false`, or `true`).

## How to extend

**Add a new browser target** (e.g. a Playwright-based target):
1. Create `src/targets/my-target.ts` exporting a factory that returns a `BrowserTarget` (interface in `src/browser-service.ts`).
2. Implement `id`, `name`, `description`, `kind`, `priority`, `available()`, and `execute(command)`. Throw a clear `Error` for unsupported subactions instead of silently ignoring them.
3. Register in `BrowserService.start` (in `src/browser-service.ts`) or let another plugin call `browserService.registerTarget(myTarget)` at init.

**Add a new action**:
1. Create `src/actions/my-action.ts` exporting an `Action` object.
2. Import it in `src/plugin.ts` and add to the `actions` array (wrap with `promoteSubactionsToActions` if it has subactions).
3. Export from `src/index.ts`.

**Add a new route**: extend the workspace route surface in `src/routes/workspace-setup.ts` and validate its authorization boundary.

## Conventions / gotchas

- **Read failures retain their effect classification.** Failed get/state/snapshot calls remain `success: false` and keep their error, but are marked read-only so a harmless miss cannot override later completed work. Uncertain dispatch outcomes and failed mutations keep failure authority.
- **Navigation is not a page read.** Web workspace open/navigate returns `pageContentObserved: false`: its tab title is a provisional label. The action receipt preserves that distinction for the planner; use a page read for title/content questions. Navigation-only requests need no extra read. Other targets keep their existing observation contracts.
- **Target routing is pluggable.** Do not hard-code target IDs in actions. The `BROWSER` action passes an optional `target` param; if omitted, `BrowserService.resolveTarget` picks the best available one by score and availability.
- **Autofill-login is vault-gated.** The agent cannot bypass the `creds.<domain>.:autoallow` flag. Do not add fallback flows that prompt the user interactively — the action is designed for autonomous use only when pre-authorized.
- **Bundle-safety guard in `src/index.ts`.** The double-import pattern (re-export + local binding in `__bundle_safety_*`) prevents Bun's tree-shaker from collapsing barrel `init` functions into empty functions on mobile. Do not remove it.
- **`auto-enable.ts` must stay import-free.** The elizaOS auto-enable engine loads this module for every plugin at boot; it must not transitively import the plugin runtime.
- See the repo root AGENTS.md for global architecture rules (logger-only, ESM, dependency direction, etc.).

## Verification

Follow the repository-wide verification and evidence standard in the [root AGENTS.md](../../AGENTS.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

Successful snapshot/state/get observations are internal read-only results. This lets the existing planner continue pending dependent work with the complete returned data; it does not certify task completion, bypass failures, or classify navigation/click/type as reads.

Promoted navigation and session-state aliases omit element selector/text arguments they do not consume. Page reads and interactions retain those arguments, and the parent keeps its full contract. Use snapshot for page text or get with a selector (title for the document title); state/info/context/get_context expose session metadata rather than page content.
