# @elizaos/ui

Shared React UI library for elizaOS apps: primitives, composites, layouts, the
agent dashboard shell (`App.tsx`), the typed HTTP/WS API client, agent-surface
view instrumentation, GenUI, voice, and platform/bridge glue.

## Purpose / role

A single design-system + runtime-glue package consumed by every elizaOS
front-end and by plugin UIs. Importers include `@elizaos/app` (web + desktop
shell), `@elizaos/app-core`, `@elizaos/cloud-frontend`, `@elizaos/os-homepage`,
the `eliza-app` homepage, and many plugin UI packages (`plugin-wallet-ui`,
`plugin-messages`, `plugin-training`, `plugin-feed`, etc.).
Plugins consume the agent-surface hooks, the registries (`app-shell-registry`,
widgets, overlay-apps), and the component/primitive exports. React/react-dom are
**peer** deps (19.2.5) — the host owns React; plugin view bundles externalise
`@elizaos/ui` + `react` so hooks resolve to the host singleton.

## Layout

```
src/
  index.ts                    Main barrel (huge re-export surface; see exports below)
  styles.ts                   Renderer-only CSS entry (@elizaos/ui/styles) — kept
                              separate so Node plugin loaders can import the barrel
                              without evaluating .css
  App.tsx                     Top-level agent dashboard shell component
  app-shell-registry.ts       registerAppShellPage / listAppShellPages — runtime nav tabs
  app-shell-components.ts      Slot registry for host-injected shell components
  build-variant.ts            getBuildVariant() "store" | "direct" (Vite define)

  agent-surface/              View instrumentation: useAgentElement, AgentSurfaceProvider,
                              AgentElementOverlay, capability registry. See its README.md.
  api/                        Typed client. ElizaClient (client-base.ts) + client-*.ts
                              modules (agent, chat, cloud, automations, ...). Barrel: api/index.ts
                              android-native-agent-transport.ts / ios-local-agent-transport.ts
  bridge/                     Desktop/native bridges: electrobun-rpc, capacitor-bridge,
                              plugin-bridge, storage-bridge, native-plugins
  platform/                   Platform guards + runtime detection (android/ios/native),
                              browser-launch, mobile/desktop permission clients
  state/                      React contexts + stores (AppContext, ChatComposerContext,
                              ui-preferences, useWalletState, PtySessionsContext, ...)
  components/                 All React components, grouped by surface:
    primitives/  ui/          Base primitives (button, switch, tabs, textarea, ...).
                              components/ui/ is the ONLY primitive layer in the
                              package — nothing else may re-implement a base element.
    composites/               Higher-level pieces (sidebar, page-panel, ...)
    shell/                    ChatSurface, AssistantOverlay, HomePill, shell-state reducer
    apps/                     Overlay/game app surfaces + registries + AppWindowRenderer
    cockpit/                  Coding-cockpit deck primitives (CockpitView, CockpitModePicker, CockpitTierToggle, CockpitNewSessionForm) — barrel-exported for plugin-task-coordinator's /cockpit route
    character/ chat/ config-ui/ pages/ settings/ steward/ voice/ voice-pill/ ...
  cloud-ui/                   Cloud-frontend component set (@elizaos/ui/cloud-ui):
                              dashboard, docs, data-list, monetization, analytics,
                              theme provider, runtime shims (dynamic/Image/navigation). Own index.css.
                              Contains NO primitives — its barrel re-exports
                              components/ui/* and adds cloud-only skins (brand/) and
                              compositions on top of them.
  config/                     Boot config, branding, plugin-config UI-spec engine
                              (buildPluginConfigUiSpec, evaluateVisibility, validators, catalogs)
  genui/                      Agent-generated UI (A2UI-compatible subset): validator,
                              renderer, actions, streaming. See genui/README.md
  spatial/                    Unified tri-modal view framework: author a view ONCE
                              with the primitives (Stack/Text/Card/Button/…); the
                              same React tree renders to GUI + XR (DOM, dom.tsx) and
                              TUI (terminal lines, spatial/tui via @elizaos/tui),
                              all from one layout IR (ir.ts). See spatial/README.md.
                              Browser barrel: @elizaos/ui/spatial; terminal renderer
                              (Node-only): @elizaos/ui/spatial/tui
  navigation/                 Tab model + default-landing resolution (resolveDefaultLandingTab)
  layouts/                    page-layout, content-layout, chat-panel-layout, workspace-layout
  services/                   Client-side services: local-inference (model catalog,
                              downloader, engine, assignments), app-updates
  storage/                    Client-side storage utilities
  terminal/                   Terminal palette + theme helpers
  backgrounds/                The unified app background. AppBackground (mounted once at
                              the shell root) renders the persisted BackgroundConfig as a
                              ShaderBackground (breathing color field) or ImageBackground
                              (cover image), shared by the home + every view. It also
                              installs useBackgroundApplyChannel — the single subscriber to
                              the agent's `background:apply` view event (chat → background).
                              BackgroundHost is a separate static solid host for
                              marketing/landing/login pages. State + undo history live in
                              state/useDisplayPreferences + state/persistence; the
                              /background view and the BACKGROUND action (plugin-app-control)
                              both drive the same store.
  views/                      View event bus + interact protocol (STANDARD_CAPABILITIES)
  hooks/                      ~35 hooks (useMediaQuery, useActivityEvents, useRenderGuard, ...);
                              many more use* hooks live alongside their features
  widgets/                    Chat sidebar widget registry + WidgetHost + visibility
  themes/                     apply-theme, presets
  voice/                      Voice capture factory, character voice config, local ASR
  events/                     Custom DOM event names + dispatch helpers (APP_EMOTE_EVENT, ...)
  i18n/                       UiLanguage, message catalogs, region helpers
  first-run/                  Deep-link routing, first-run config, pre-seed local runtime
  content-packs/              Content pack load/apply (bundled-packs)
  providers/                  AI provider logo registry (getProviderLogo, registerProviderLogo)
  utils/  lib/                Formatters, SQL helpers, rate limiters, cn(), floating-layers z-index
  slots/                      Plugin slot components (task-coordinator-slots)
  styles/  stories/             CSS modules, story fixtures
test/                           Test doubles (top-level, not under src/)
```

## Key exports / surface

The root barrel `@elizaos/ui` re-exports nearly everything. Notable subpath
entries (see `exports` in package.json) so importers avoid the giant barrel:

- `@elizaos/ui/styles` and `@elizaos/ui/styles/*.css` — CSS (renderer-only)
- `@elizaos/ui/cloud-ui`, `@elizaos/ui/cloud-ui/index.css` — cloud-frontend set
- `@elizaos/ui/api`, `@elizaos/ui/api/*` — typed client (`ElizaClient`)
- `@elizaos/ui/bridge`, `@elizaos/ui/state`, `@elizaos/ui/state/*`
- `@elizaos/ui/components`, `@elizaos/ui/components/*`, `@elizaos/ui/config`
- `@elizaos/ui/hooks`, `@elizaos/ui/layouts`, `@elizaos/ui/navigation`
- `@elizaos/ui/genui`, `@elizaos/ui/voice`, `@elizaos/ui/widgets`, `@elizaos/ui/events`
- `@elizaos/ui/lib/utils` — just `cn()` (browser-safe; use this instead of the
  `./utils` barrel when bundling the kit, since `./utils` re-exports Node-side
  helpers from `@elizaos/shared`)
- `@elizaos/ui/platform`, `@elizaos/ui/providers`, `@elizaos/ui/types`, `@elizaos/ui/utils`
- `@elizaos/ui/app-shell-registry`, `@elizaos/ui/button`, `@elizaos/ui/card`,
  `@elizaos/ui/input`, `@elizaos/ui/dropdown-menu` — direct-component shortcuts
  (all resolve to the canonical `components/ui/*` primitives)

Registries plugins/hosts call at runtime: `registerAppShellPage` (nav tabs),
`registerProviderLogo` (provider logos), the overlay-app and game-surface
registries under `components/apps/`, the widget `registry-store`, and
`useAgentElement` for agent-controllable view elements.

## Commands

This is a library — no dev server (use the host app's). Scripts from package.json:

```bash
bun run --cwd packages/ui build               # build:dist → dist/ (locked tsc + asset copy)
bun run --cwd packages/ui typecheck           # tsgo --noEmit
bun run --cwd packages/ui test                # vitest (vitest.config.ts)
bun run --cwd packages/ui test:e2e            # slow suite (vitest.e2e.config.ts)
bun run --cwd packages/ui test:agent-surface-e2e   # agent-surface __e2e__ runner
bun run --cwd packages/ui test:chat-sheet-e2e      # continuous-chat pull-sheet drag-gesture __e2e__ runner
bun run --cwd packages/ui test:home-screen-e2e     # home-screen __e2e__ runner
bun run --cwd packages/ui test:chat-ambient-e2e    # /chat ambient orange-pulse background screenshot __e2e__ runner
bun run --cwd packages/ui lint                # biome check --write src
bun run --cwd packages/ui lint:check          # biome check src (read-only)
bun run --cwd packages/ui format / format:check # biome format write / read-only
bun run --cwd packages/ui stories:dev         # Vite stories (stories/vite.config.ts)
bun run --cwd packages/ui storybook           # Storybook dev server (port 6006)
bun run --cwd packages/ui build-storybook     # Storybook static build
bun run --cwd packages/ui clean
```

## Testing

The UI has four complementary layers. Prefer the cheapest layer that can catch a
given class of bug; reach for the heavier ones when behaviour or pixels matter.

1. **Unit / component (`test`, vitest + jsdom).** Co-locate `*.test.tsx` with the
   component. Render with `@testing-library/react`, drive with `user-event`,
   assert on DOM/roles. Setup pins `TZ=UTC`; for clock/RNG-derived UI opt into
   `test/determinism.ts` (`withFrozenClock()`, `withSeededRandom()`) so renders
   are reproducible. Runs in CI via `test:client`.

2. **Determinism lint (`audit:ui-determinism`, repo root).** A TS-AST gate that
   fails CI on **new** render-time nondeterminism — `Date.now()`, `new Date()`,
   `Math.random()`, `crypto.randomUUID()`, locale-defaulted `toLocale*` in a
   component/hook render path (the root cause of flaky screenshots). It classifies
   by execution context, so effect/handler/timer usage is fine. Existing backlog
   is tracked in `packages/scripts/ui-determinism-baseline.json`; if a new
   occurrence is intentional, run `audit:ui-determinism:update` and commit the
   baseline. Wired into `ci.yaml`.

3. **Story gate (`audit:stories`, `test/story-gate/`).** Renders **every**
   Storybook story in headless Chromium and HARD-fails on a story that throws,
   renders blank, or raises a pageerror; console errors + serious/critical axe
   a11y violations are enforced once their baselines are populated. A determinism
   shim (frozen clock / seeded RNG / en-US-UTC / animations off) makes every
   screenshot byte-stable. App-context-dependent stories are classified soft
   `needs-runtime` (covered live by `audit:app`), not failed. Build the catalog
   first (`build-storybook --output-dir storybook-static`), then run the gate;
   the dedicated `.github/workflows/ui-story-gate.yml` does both on `packages/ui`
   changes. Reusable helpers: `determinism-shim.mjs`, `log-capture.mjs`
   (durable frontend console/network artifact), `backend-log-capture.mjs`.

4. **Isolated browser e2e (`test:*-e2e`, `src/**/__e2e__/`).** esbuild-bundle a
   fixture → headless Chromium for gesture/animation/flow coverage no jsdom can
   reach (chat sheet detents, home screen, onboarding, agent surface). Author one
   when a behaviour depends on real layout, pointer events, or timing.

Every new story automatically gains story-gate coverage; a new interactive
component should ship at least a `*.stories.tsx` (states) **and** a `*.test.tsx`
(behaviour). The live full-app visual audit lives in `packages/app`
(`audit:app`) and `packages/cloud-frontend` (`audit:cloud`).

## Config / env vars

This package mostly reads config injected by the host, not raw env vars:

- `__ELIZA_BUILD_VARIANT__` — Vite `define` consumed by `build-variant.ts`
  (`"store"` | `"direct"`, default `"direct"`).
- Eliza API base/token are runtime values managed via the api client helpers
  (`setElizaApiBase` / `setElizaApiToken` / `getElizaApiBase` / `getElizaApiToken`),
  not read from `process.env` here.
- Boot config + branding live in `config/` (`getBootConfig` / `setBootConfig`,
  `resolveAppBranding`) and are seeded by the host.

## How to extend

- **Add a component:** put it in the right `components/<surface>/` dir, then export
  it from that surface's `index.ts` (and `src/index.ts` only if broadly shared).
  Prefer a subpath export over bloating the root barrel.
- **Add a primitive:** add under `components/ui/` (the single primitive layer),
  re-export via `components/primitives/index` / the existing barrel. Never add a
  second implementation of a base element elsewhere (cloud-ui included) — add a
  variant to the canonical component, or a composition on top of it.
- **Add a nav tab at runtime:** call `registerAppShellPage(registration)`
  (`app-shell-registry.ts`) from the host/plugin; the shell + `navigation/`
  pick it up.
- **Make a view agent-controllable:** use `useAgentElement` — see
  `src/agent-surface/README.md` for ids/roles/controlled-component rules.
- **Add a cloud-frontend component:** add under `cloud-ui/components/` and export
  from `cloud-ui/index.ts`; it ships under the `@elizaos/ui/cloud-ui` subpath.
  Import primitives from `../../components/ui/*` — do not create re-export shims
  or local copies of base elements inside `cloud-ui/`.

## Conventions / gotchas

- `index.ts` is CSS-free on purpose. Stylesheets are imported only via
  `styles.ts` (`@elizaos/ui/styles`) so Node-side plugin loaders can import the
  barrel without Node choking on `.css`. Never `import "./styles/..."` from
  `index.ts`.
- React is a peer dep; never bundle it. Plugin view bundles externalise
  `@elizaos/ui` + `react` (see `packages/scripts/view-bundle-vite.config.ts`) so
  hooks share the host React singleton.
- The build (`build:dist:unlocked`) is a multi-step `tsc --noCheck` +
  flatten/copy/rewrite pipeline driven by scripts in `../scripts/`; use
  `bun run build`, don't invoke `tsc` directly.
- **Toasts & notifications — one system per surface.** The app shell's only
  transient toast is `setActionNotice` (`state/action-notice.ts`, rendered by
  `ShellOverlays`); cloud-ui's only toast is its themed `sonner` wrapper
  (`cloud-ui/components/sonner.tsx`). Never mount both in one tree, and never
  add a third toast library. Persistent notifications are the notification
  store (`state/notifications/notification-store.ts`) rendered by the pinned
  dashboard center (`components/shell/NotificationsHomeCenter.tsx`) — the one
  in-app inbox surface; interrupt-worthy items reach the user through the
  store's toast sink + the native/desktop bridges, not through a bespoke
  banner.
- `ConnectionStatus` exists twice (cloud-ui string union vs. the composite
  component) — the cloud-ui one is intentionally NOT re-exported from the root
  barrel to avoid the collision (see comment in `index.ts`).
- Type root `src/types/index.ts` re-exports from `@elizaos/shared/types`; keep
  shared transport/domain types there rather than redefining them here.
- **Files / attachments.** The "Files" tab (`components/pages/FilesView.tsx`,
  routed at `/apps/files`) lists stored files via `ElizaClient.listFiles()` /
  `deleteFile()` (`api/client-files.ts`) and reuses `utils/download-share.ts`
  (transport-aware download/share — web `<a download>`/`showSaveFilePicker`,
  native Capacitor bridge) + `utils/attachment-url.ts` (scheme allowlist) +
  `attachmentPreviewKind` in `components/chat/MessageAttachments.tsx` (image /
  PDF / text-code preview kinds derived from mime at read time). Large pasted
  text becomes a text attachment via `utils/image-attachment.ts`. Don't add a
  second download path or attachment-URL guard — reuse these. See issue #8876.
- Build/test conventions and the repo-wide architecture rules live in the root
  AGENTS.md — don't restate them; follow them.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — UI surface:**
- Before/after **full-page** screenshots — desktop **and** mobile, portrait **and** landscape, rest **and** hover (`bun run --cwd packages/app audit:app` where applicable) — not desktop-only-happy-path (see #9950).
- A **video walkthrough** of the whole view/flow, plus browser console + network logs showing the real request/response and state change.
- Empty, loading, error, and permission-denied states — and fill the per-view manual-review verdict (`good`/`needs-work`/`needs-eyeball`/`broken`); no page ships `needs-work`/`broken`.
- The backend trajectory/logs behind anything the UI triggered.
<!-- END: evidence-and-e2e-mandate -->
