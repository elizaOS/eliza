# @elizaos/plugin-feed

Operator surface for the Feed prediction market game, embedded as an elizaOS app plugin.

## Purpose / role

Connects an Eliza agent to the Feed prediction market platform. It registers **one** adaptive UI view (GUI + XR + TUI from a single source) and a full HTTP proxy layer that forwards agent, market, social, messaging, and admin requests to the Feed backend. The plugin is opt-in — add it to an agent's character or plugin list; it is not auto-enabled. Configuration is read entirely from env vars or agent settings.

## Plugin surface

This plugin registers **views** only — no actions, providers, services, or evaluators. All runtime behaviour is UI-side or route-proxy-side.

**View** (registered in `src/index.ts`) — ONE declaration drives all three modalities:

| id | label | modalities | componentExport | description |
|----|-------|------------|-----------------|-------------|
| `feed` | Feed | `gui`, `xr`, `tui` | `FeedView` | Feed prediction market operator dashboard |

`FeedView` (`src/components/FeedView.tsx`) owns the live data layer and renders the one presentational `FeedSpatialView` inside a `SpatialSurface` — DOM in GUI, scaled DOM in XR. The TUI surface mounts the SAME `FeedSpatialView` through the terminal registry (`src/register-terminal-view.tsx`). The view declares capabilities: `get-state`, `refresh-agent-status`, `open-live-dashboard`, `send-team-message` (handled by `src/ui/feed-interact.ts`).

**Route exports** (from `src/routes.ts`, consumed by the elizaOS app-core host):

| export | description |
|--------|-------------|
| `handleAppRoutes(ctx)` | Main proxy handler — all `/api/apps/feed/…` routes |
| `resolveLaunchSession(ctx)` | Returns `AppSessionState` at launch |
| `refreshRunSession(ctx)` | Refreshes session state during an active run |
| `prepareLaunch(ctx)` | Pre-launch credential check + diagnostics |
| `resolveViewerAuthMessage(ctx)` | Returns `FEED_AUTH` postMessage token for embedded viewer |

## Layout

```
plugins/plugin-feed/
  src/
    index.ts                        Plugin object: ONE view declaration + re-exports
    feed-auth.ts                    Auth helpers: resolveFeedConfig, proxyFeedRequest,
                                    persistFeedCredential, resolveSettingLike, FeedConfig
    routes.ts                       Full HTTP proxy layer — all /api/apps/feed/* routes
    register.ts                     Renderer/native app-shell registration entry
    register-terminal-view.tsx      Registers FeedSpatialView for the terminal (TUI)
    components/
      FeedView.tsx                  GUI/XR wrapper: live data layer + <SpatialSurface>
      FeedSpatialView.tsx           Presentational spatial view — renders in all modalities
    ui/
      feed-data.ts                  Pure data parsers: extractAgentSummary,
                                    extractTeamDashboard, summarizeFeedActivity, etc.
      feed-view-bundle.ts           View-bundle entry (exports FeedView + interact)
      feed-interact.ts              TUI interact() capability handler
  assets/
    hero.png                        App store hero image
  vite.config.views.ts              Vite config for the view bundle (dist/views/bundle.js)
  tsconfig.build.json
```

## Commands

All scripts in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-feed build          # JS + views bundle + types
bun run --cwd plugins/plugin-feed build:js       # tsup (../tsup.plugin-packages.shared.ts): transpiles every src file → dist/
bun run --cwd plugins/plugin-feed build:views    # Vite: src/ui/feed-view-bundle.ts → dist/views/bundle.js
bun run --cwd plugins/plugin-feed build:types    # tsc: type declarations
bun run --cwd plugins/plugin-feed clean          # rm -rf dist
bun run --cwd plugins/plugin-feed test           # vitest run
```

## Config / env vars

Resolved in `src/feed-auth.ts` via `resolveSettingLike` (checks `runtime.getSetting` first, then `process.env`):

| Env var | Required | Default | Description |
|---------|----------|---------|-------------|
| `FEED_AGENT_ID` | Yes (for trading) | — | Feed agent identifier |
| `FEED_AGENT_SECRET` | Yes (for trading) | — | Feed agent secret for session auth |
| `FEED_API_URL` | No | `http://localhost:3000` (dev) / `https://staging.feed.market` (prod) | Feed backend API base URL |
| `FEED_APP_URL` | No | falls back to `FEED_API_URL` | Alternate URL key (alias) |
| `FEED_CLIENT_URL` | No | falls back to `FEED_API_URL` | Client-facing URL used in viewer embed and `launchUrl` |
| `FEED_A2A_API_KEY` | No | — | Agent-to-agent API key sent as `X-Feed-Api-Key` header |
| `STEWARD_AGENT_TOKEN` | No | — | The agent's Steward/Eliza-Cloud session JWT. When present, the plugin forwards it as `Authorization: Bearer` and skips the `FEED_AGENT_ID/SECRET` exchange (shared-secret SSO). Set by the app-core Steward sidecar. |
| `FEED_STEWARD_TOKEN` | No | falls back to `STEWARD_AGENT_TOKEN` | Explicit per-app override for the Steward JWT used to auth to Feed. |

In `NODE_ENV !== "production"`, the plugin will attempt to auto-provision credentials from the dev Feed server by probing known dev agent IDs and hostname-derived secrets. Provisioned credentials are persisted to `runtime.setSetting` and `process.env`.

Session tokens (`FEED_AGENT_SESSION_TOKEN`, `FEED_AGENT_SESSION_EXPIRES_AT`) are derived at runtime and stored via `persistFeedCredential` — do not set these manually.

## How to extend

**Add a new proxied route:**

1. Open `src/routes.ts` and add a new branch in `handleAppRoutes`. Use `proxyGet` or `proxyPost` helpers:
   ```ts
   if (ctx.method === "GET" && path === "/my/new/route") {
     return proxyGet(config, "/api/my/new/route", ctx);
   }
   ```
2. Routes are matched against the path after the `/api/apps/feed` prefix (stripped by `subpath()`).

**Change the operator surface UI:**

1. Edit the one presentational component `src/components/FeedSpatialView.tsx` — authored with `@elizaos/ui/spatial` primitives (`Card`, `Text`, `Button`, `HStack`, `VStack`, `List`). It renders correctly in GUI, XR, and TUI from the same source. Keep it purely presentational (snapshot in, `onAction` out).
2. Live-data wiring (loaders, refresh poll, autonomy control) lives in the GUI/XR wrapper `src/components/FeedView.tsx`; the same `FeedSpatialView` is fed a module-level snapshot for TUI in `src/register-terminal-view.tsx`.
3. New TUI capabilities go in `src/ui/feed-interact.ts` (re-exported by `src/ui/feed-view-bundle.ts`) AND must be declared in the view's `capabilities` array in `src/index.ts`.

**Add a new view:**

1. Add a view entry to the `views` array in `src/index.ts`.
2. If the component needs its own bundle, update `vite.config.views.ts` or create a separate Vite config.

## Conventions / gotchas

- The view bundle (`dist/views/bundle.js`) is built separately by Vite (`build:views`). Running only `build:js` leaves the views stale. Always run `build` or `build:views` before shipping a UI change.
- There is exactly ONE view component: `FeedSpatialView`. `FeedView` (the bundle's `componentExport`) is a thin GUI/XR data wrapper around it; `register-terminal-view.tsx` mounts the same `FeedSpatialView` for TUI. Do NOT reintroduce a separate rich-DOM operator surface or a separate TUI component — the spatial view is the single source for all modalities.
- The `elizaos.app` block in `package.json` controls how the elizaOS app manager discovers and launches Feed: `launchType: "url"`, viewer `postMessageAuth: true`, session mode `spectate-and-steer`.
- Auth is Steward-first: `proxyFeedRequest` prefers the agent's Steward JWT (`STEWARD_AGENT_TOKEN`/`FEED_STEWARD_TOKEN`) and forwards it as `Authorization: Bearer` with no `/api/agents/auth` exchange (Feed verifies the shared-secret HS256 `iss:"steward"` token inline). On 401 it falls back to the `FEED_AGENT_ID/SECRET` agent-session path, which uses an in-process token cache (`cachedToken`) cleared + re-authed once on its own 401.
- `persistFeedCredential` writes to both `process.env` and `runtime.setSetting` and patches the character's `settings.secrets` in-memory. This means credentials set during auto-provisioning survive in the runtime object but are not written to disk automatically.
- No actions, providers, evaluators, or services are registered. This plugin is purely presentation + proxy.
- See the root `AGENTS.md` for repo-wide conventions (logger usage, ESM, architecture rules, naming).
