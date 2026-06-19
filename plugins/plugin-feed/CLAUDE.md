# @elizaos/plugin-feed

Operator surface for the Feed prediction market game, embedded as an elizaOS app plugin.

## Purpose / role

Connects an Eliza agent to the Feed prediction market platform. It registers three UI views (standard, XR, TUI) and a full HTTP proxy layer that forwards agent, market, social, messaging, and admin requests to the Feed backend. The plugin is opt-in — add it to an agent's character or plugin list; it is not auto-enabled. Configuration is read entirely from env vars or agent settings.

## Plugin surface

This plugin registers **views** only — no actions, providers, services, or evaluators. All runtime behaviour is UI-side or route-proxy-side.

**Views** (registered in `src/index.ts`):

| id | label | viewType | componentExport | description |
|----|-------|----------|-----------------|-------------|
| `feed` | Feed | (default) | `FeedOperatorSurface` | Operator dashboard |
| `feed` | Feed XR | `xr` | `FeedOperatorSurface` | XR variant |
| `feed` | Feed TUI | `tui` | `FeedTuiView` | Terminal operator dashboard |

The TUI view declares capabilities: `get-state`, `refresh-agent-status`, `open-live-dashboard`, `send-team-message`.

**UI registrations** (in `src/ui/index.ts`):

- `registerOperatorSurface("@elizaos/plugin-feed", FeedOperatorSurface)` — surfaces into the elizaOS app manager.
- `registerDetailExtension("feed-operator-dashboard", FeedDetailExtension)` — injects a detail panel into the elizaOS UI shell.

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
    index.ts                        Plugin object: view registrations + re-exports
    feed-auth.ts                    Auth helpers: resolveFeedConfig, proxyFeedRequest,
                                    persistFeedCredential, resolveSettingLike, FeedConfig
    routes.ts                       Full HTTP proxy layer — all /api/apps/feed/* routes
    feed-data.ts                    Pure data helpers: extractAgentSummary,
                                    extractTeamDashboard, summarizeFeedActivity, etc.
    feed-view-bundle.ts             View bundle entry point
    register-terminal-view.tsx      Terminal view registration helper
    game-surface-shell.tsx          Game surface shell component
    FeedOperatorSurface.interact.ts Interactive logic for FeedOperatorSurface
    components/
      FeedSpatialView.tsx           Spatial/XR view component
    ui/
      index.ts                      Registers operator surface + detail extension
      FeedOperatorSurface.tsx       Main React dashboard component
      FeedDetailExtension.tsx       Detail panel extension component
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
bun run --cwd plugins/plugin-feed build:views    # Vite: src/ui/FeedOperatorSurface.tsx → dist/views/bundle.js
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

**Add a new UI component:**

1. Create the React component under `src/ui/`.
2. Export it from `src/ui/index.ts`.
3. Register it via `registerOperatorSurface` or `registerDetailExtension` from `@elizaos/app-core/ui-compat` if it needs to surface in the elizaOS shell.

**Add a new view:**

1. Add a view entry to the `views` array in `src/index.ts`.
2. If the component needs its own bundle, update `vite.config.views.ts` or create a separate Vite config.

## Conventions / gotchas

- The view bundle (`dist/views/bundle.js`) is built separately by Vite (`build:views`). Running only `build:js` leaves the views stale. Always run `build` or `build:views` before shipping a UI change.
- `FeedOperatorSurface` and `FeedTuiView` are both exported from `dist/views/bundle.js` — the single Vite entry (`FeedOperatorSurface.tsx`) must re-export `FeedTuiView` for the TUI view to resolve at runtime.
- The `elizaos.app` block in `package.json` controls how the elizaOS app manager discovers and launches Feed: `launchType: "url"`, viewer `postMessageAuth: true`, session mode `spectate-and-steer`.
- Auth uses an in-process token cache (`cachedToken` in `feed-auth.ts`). On 401, the cache is cleared and one re-auth attempt is made automatically (`proxyFeedRequest`).
- `persistFeedCredential` writes to both `process.env` and `runtime.setSetting` and patches the character's `settings.secrets` in-memory. This means credentials set during auto-provisioning survive in the runtime object but are not written to disk automatically.
- No actions, providers, evaluators, or services are registered. This plugin is purely presentation + proxy.
- See the root `AGENTS.md` for repo-wide conventions (logger usage, ESM, architecture rules, naming).
