# @elizaos/plugin-screenshare

Adds authenticated desktop screen-streaming and remote mouse/keyboard control to an Eliza agent.

## Purpose / role

This plugin exposes the local machine's desktop as a streamable, interactable session accessible from any authenticated viewer. It is loaded as an elizaOS app plugin (kind: `app`, `launchType: connect`) and registered through `gatePluginSessionForHostedApp`, which gates the plugin surface behind a valid app session. No agent actions or providers are registered — the plugin surface is entirely HTTP routes plus three UI views.

## Plugin surface

### Views (registered in `plugin.views`)

| id | label | viewType | componentExport | path |
|----|-------|----------|-----------------|------|
| screenshare | Screen Share | (default) | `ScreenshareOperatorSurface` | `/screenshare` |
| screenshare | Screen Share XR | `xr` | `ScreenshareOperatorSurface` | `/screenshare` |
| screenshare | Screen Share TUI | `tui` | `ScreenshareTuiView` | `/screenshare/tui` |

Views are bundled via Vite into `dist/views/bundle.js`.

### HTTP routes (handled via `handleAppRoutes`)

All routes are under `/api/apps/screenshare/`:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/apps/screenshare/viewer` | none | Serves the self-contained viewer HTML page |
| GET | `/api/apps/screenshare/capabilities` | none | Reports platform + desktop control capabilities |
| GET | `/api/apps/screenshare/windows` | none | Lists open desktop windows via `plugin-computeruse` |
| GET | `/api/apps/screenshare/sessions` | none | Lists all tracked screenshare sessions (public fields only) |
| POST | `/api/apps/screenshare/session` | rate-limited (10/min per IP) | Creates a new screenshare session; returns `{ session, token, viewerUrl }` |
| GET | `/api/apps/screenshare/session/:id` | session token | Returns public session state |
| GET | `/api/apps/screenshare/session/:id/frame` | session token | Captures and streams a PNG screenshot |
| POST | `/api/apps/screenshare/session/:id/input` | session token | Sends mouse/keyboard input to the desktop |
| POST | `/api/apps/screenshare/session/:id/stop` | session token | Stops the session |

Token is accepted via: `?token=` query param, `X-Screenshare-Token` header, or `Authorization: Bearer <token>` header. Token is also accepted in the JSON request body for POST endpoints.

### App lifecycle hooks (exported from `routes.ts`)

- `prepareLaunch` — creates/retrieves the local session, builds the viewer URL
- `resolveLaunchSession` — returns initial `AppSessionState`
- `refreshRunSession` — returns current `AppSessionState` or `null` if session is gone/stopped
- `stopRun` — stops the session by ID

### Registered TUI capabilities (via `interact` export in `ui/ScreenshareOperatorSurface.interact.ts`)

- `terminal-screenshare-state`
- `terminal-screenshare-start`
- `terminal-screenshare-session`
- `terminal-screenshare-stop`
- `terminal-screenshare-input`
- `terminal-screenshare-viewer-url`

## Layout

```
src/
  index.ts                     Plugin definition; wraps raw plugin with gatePluginSessionForHostedApp
  routes.ts                    All HTTP route handlers + app lifecycle hooks (prepareLaunch, stopRun, etc.)
  session-store.ts             In-process session store (globalThis-keyed); session CRUD + capability detection
  register-terminal-view.tsx   Registers ScreenshareSpatialView as the terminal/TUI view
  components/
    ScreenshareSpatialView.tsx       Shared spatial operator surface component (used by TUI and other views)
    ScreenshareSpatialView.test.tsx  Unit tests for ScreenshareSpatialView
  ui/
    index.ts                              Registers ScreenshareOperatorSurface with @elizaos/ui registerOperatorSurface
    ScreenshareOperatorSurface.tsx        React operator surface (host panel + connect panel + TUI view)
    ScreenshareOperatorSurface.helpers.ts Helper utilities for the operator surface
    ScreenshareOperatorSurface.interact.ts  interact() TUI capability handler (split from main component file)
    ScreenshareOperatorSurface.interact.test.ts  Tests for interact()
    ScreenshareOperatorSurface.contract.test.ts  Contract tests for the operator surface
    ScreenshareOperatorSurface.test.tsx   Unit tests for ScreenshareOperatorSurface
    ScreenshareTuiView.test.tsx           Unit tests for TUI view
    screenshare-view-bundle.ts            View bundle entry point
```

## Commands

```bash
bun run --cwd plugins/plugin-screenshare build         # tsup + vite views + tsc types
bun run --cwd plugins/plugin-screenshare build:js      # tsup (runtime bundle only)
bun run --cwd plugins/plugin-screenshare build:views   # Vite (UI bundle for views)
bun run --cwd plugins/plugin-screenshare build:types   # tsc declarations
bun run --cwd plugins/plugin-screenshare test          # vitest run
bun run --cwd plugins/plugin-screenshare clean         # rm -rf dist
```

## Config / env vars

This plugin reads no env vars directly. Desktop control capability detection is delegated entirely to `@elizaos/plugin-computeruse` (`detectDesktopControlCapabilities`, `getDesktopPlatformName`). Runtime capability checks cover:

- `headfulGui` — whether a display server is available
- `screenshot` — whether screenshot capture is available
- `computerUse` — whether mouse/keyboard control is available

The `GET /capabilities` route reports all three capability flags along with which tool backs each one. If any are unavailable, `prepareLaunch` emits `warning`-level `AppLaunchDiagnostic` entries so the elizaOS app system can surface them.

## How to extend

**Add a new route:** Add a branch in `handleAppRoutes` in `src/routes.ts`. Follow the pattern of reading and validating query/body params, calling session-store helpers or `@elizaos/plugin-computeruse` primitives, and replying with `ctx.json` / `ctx.error`.

**Add a new input type:** Add a branch in `executeInput` in `src/routes.ts`. Dispatch to the appropriate `@elizaos/plugin-computeruse` primitive (e.g. `performDesktopScroll`, `performDesktopKeypress`).

**Add a new TUI capability:** Add a branch in the `interact` function in `src/ui/ScreenshareOperatorSurface.interact.ts`.

**Add operator UI controls:** Add `ScreenshareActionButton` or `ScreenshareField` elements inside `ScreenshareOperatorSurface` in `src/ui/ScreenshareOperatorSurface.tsx`.

## Conventions / gotchas

- **No actions or providers.** All intelligence surface is in HTTP routes + UI views. The elizaOS agent does not get any new actions from this plugin.
- **Session store is in-process, not persisted.** `session-store.ts` stores sessions in `globalThis` under `Symbol.for("elizaos.app-screenshare.session-store")`. Sessions are lost on process restart.
- **One active local session at a time.** `createScreenshareSession` stops the previous local session before creating a new one. Use `getOrCreateLocalScreenshareSession` to reuse an existing active session instead.
- **Token is secret.** `ScreenshareSession.token` (a 24-byte base64url random) is never included in `ScreensharePublicSession`. Callers must separately track the token returned at session creation.
- **Rate limiting is in-process.** `sessionCreateRateLimitExceeded` limits POST `/session` to 10 requests per IP per minute using an in-process map. It does not survive process restart and does not apply to other routes.
- **Keypress character allowlist.** Keys sent via `type: "keypress"` must match `/^[A-Za-z0-9+_.,: -]+$/` and be under 128 characters. Special names like `Enter`, `Escape`, `Tab`, `Up`, `Down`, `Left`, `Right`, `Backspace` are mapped in the viewer JS.
- **Desktop primitives come from `@elizaos/plugin-computeruse`.** Do not reach into OS APIs directly. All screenshot and input calls go through that package.
- **Views build separately from the runtime.** `build:js` (tsup) and `build:views` (Vite) are independent steps. Both must run for a complete build.
- **Viewer HTML is inline.** `renderViewerHtml()` in `routes.ts` returns a self-contained HTML string with embedded CSS and JS — no external assets needed. It polls for frames at 500 ms intervals.
- **`interact` is a separate module.** The TUI capability handler lives in `ScreenshareOperatorSurface.interact.ts`, not in the main component file, so the component file exports only React components.
- See root `AGENTS.md` for architecture rules (logger-only, ESM, naming, layer boundaries) that apply repo-wide.
