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

`FeedView` (`src/components/FeedView.tsx`) renders differently per modality. On the **GUI** surface it embeds the **full Feed web app, authenticated as the agent**: the run's `viewer` carries the `FEED_AUTH` session token and `EmbeddedAppViewer` (from `@elizaos/ui`) runs the `*_READY` → auth postMessage handshake so the real product UI loads signed in. A cross-origin iframe can't render in XR or a terminal, so the **XR** surface (and the **TUI** surface via `src/register-terminal-view.tsx`) instead render the operator dashboard — the one presentational `FeedSpatialView`, fed by FeedView's live data layer (the ten `getFeed*` loaders + 12s poll). The view declares capabilities: `get-state`, `refresh-agent-status`, `open-live-dashboard`, `send-team-message` (handled by `src/ui/feed-interact.ts`).

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
- The **operator dashboard** has exactly ONE view component: `FeedSpatialView`, which `FeedView` renders on the XR surface and `register-terminal-view.tsx` mounts for TUI. Do NOT reintroduce a separate rich-DOM operator surface or a separate TUI component — the spatial view is the single source for the dashboard across XR + TUI. The **GUI** surface is different: it does not render the dashboard at all, it embeds the real external Feed web app via `EmbeddedAppViewer` (a cross-origin iframe + auth handshake), not a reimplemented dashboard.
- The `elizaos.app` block in `package.json` controls how the elizaOS app manager discovers and launches Feed: `launchType: "url"`, viewer `postMessageAuth: true`, session mode `spectate-and-steer`.
- Auth is Steward-first: `proxyFeedRequest` prefers the agent's Steward JWT (`STEWARD_AGENT_TOKEN`/`FEED_STEWARD_TOKEN`) and forwards it as `Authorization: Bearer` with no `/api/agents/auth` exchange (Feed verifies the shared-secret HS256 `iss:"steward"` token inline). On 401 it falls back to the `FEED_AGENT_ID/SECRET` agent-session path, which uses an in-process token cache (`cachedToken`) cleared + re-authed once on its own 401.
- `persistFeedCredential` writes to both `process.env` and `runtime.setSetting` and patches the character's `settings.secrets` in-memory. This means credentials set during auto-provisioning survive in the runtime object but are not written to disk automatically.
- No actions, providers, evaluators, or services are registered. This plugin is purely presentation + proxy.
- See the root `AGENTS.md` for repo-wide conventions (logger usage, ESM, architecture rules, naming).

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

**Capture & manually review for this package — storage / memory:**
- The actual rows / embeddings / documents written **and read back**, with their shape inspected — not a mock asserting itself.
- Query correctness: precision/recall on real data, ordering, pagination, and migration up/down.
- GC/retention, concurrency, and large-payload paths.
- A trajectory showing memory/knowledge actually recalled into a turn, where relevant.
<!-- END: evidence-and-e2e-mandate -->
