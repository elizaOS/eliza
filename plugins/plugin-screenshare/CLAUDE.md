# @elizaos/plugin-screenshare

Adds authenticated desktop screen-streaming and remote mouse/keyboard control to an Eliza agent.

## Purpose / role

This plugin exposes the local machine's desktop as a streamable, interactable session accessible from any authenticated viewer. It is loaded as an elizaOS app plugin (kind: `app`, `launchType: connect`) and registered through `gatePluginSessionForHostedApp`, which gates the plugin surface behind a valid app session. No agent actions or providers are registered — the plugin surface is entirely HTTP routes plus one adaptive UI view.

## Plugin surface

### Views (registered in `plugin.views`)

ONE declaration drives all three modalities from a single authored source.

| id | label | modalities | componentExport | path | bundlePath |
|----|-------|------------|-----------------|------|------------|
| screenshare | Screen Share | gui, xr, tui | `ScreenshareView` | `/screenshare` | `dist/views/bundle.js` |

`ScreenshareView` (`components/ScreenshareView.tsx`) is the single GUI/XR data wrapper — it owns the live operator data (capability fetch/poll, host start/stop/rotate, copy/open-viewer, remote connect, refresh) and renders the one presentational `ScreenshareSpatialView` (`components/ScreenshareSpatialView.tsx`) inside a `SpatialSurface`. The same `ScreenshareSpatialView` is registered for terminal/TUI rendering via `register-terminal-view.tsx`. Views are bundled via Vite into `dist/views/bundle.js` (entry `ui/screenshare-view-bundle.ts`, which re-exports `ScreenshareView` plus the `interact` TUI capability handler).

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

### Registered TUI capabilities (via `interact` export in `ui/screenshare-interact.ts`)

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
    ScreenshareView.tsx              Single GUI/XR data wrapper (owns fetch/poll + host/remote actions); renders ScreenshareSpatialView in a SpatialSurface
    ScreenshareView.test.tsx         Unit tests for ScreenshareView (the GUI/XR surface)
    ScreenshareSpatialView.tsx       The one presentational spatial component (GUI DOM, scaled XR DOM, terminal TUI)
    ScreenshareSpatialView.test.tsx  Unit tests for ScreenshareSpatialView
  ui/
    screenshare-view-bundle.ts                 View bundle entry: re-exports ScreenshareView + interact
    screenshare-helpers.ts                     Shared data contracts + fetch helpers (used by ScreenshareView and interact)
    screenshare-interact.ts                    interact() TUI capability handler (kept out of the component file)
    screenshare-interact.test.ts               Tests for interact() (all capabilities + dispatch types + guards)
    screenshare-capabilities.contract.test.ts  Contract test: real detectDesktopControlCapabilities() shape vs the helper types
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

**Add a new TUI capability:** Add a branch in the `interact` function in `src/ui/screenshare-interact.ts`.

**Add UI controls:** Edit the one presentational `ScreenshareSpatialView` (`src/components/ScreenshareSpatialView.tsx`) — it renders for GUI, XR, and TUI. Wire any new control through `ScreenshareView`'s `onAction` handler (`src/components/ScreenshareView.tsx`).

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
- **One component, all modalities.** `ScreenshareView` is the single authored view: DOM in GUI, scaled DOM in XR, terminal in TUI. There is no separate operator-surface / TUI-view duplicate — `ScreenshareSpatialView` is the only presentational source, registered for TUI via `register-terminal-view.tsx`.
- **`interact` is a separate module.** The TUI capability handler lives in `ui/screenshare-interact.ts`, not in a component file, so component files export only React components (keeping them Fast-Refresh-compatible).
- See root `AGENTS.md` for architecture rules (logger-only, ESM, naming, layer boundaries) that apply repo-wide.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
