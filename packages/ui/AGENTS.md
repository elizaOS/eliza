# @elizaos/ui

Shared React UI library for elizaOS apps: primitives, composites, layouts, the
agent dashboard shell (`App.tsx`), the typed HTTP/WS API client, agent-surface
view instrumentation, GenUI, voice, and platform/bridge glue.

## Purpose / role

A single design-system + runtime-glue package consumed by every elizaOS
front-end and by plugin UIs. Importers include `@elizaos/app` (web + desktop
shell), `@elizaos/app-core`, the Cloud surfaces in `@elizaos/app`, the `eliza-app`
homepage, and many plugin UI packages (`plugin-wallet`,
`plugin-messages`, `plugin-notes`, etc.).
Plugins consume the agent-surface hooks, the registries (`app-shell-registry`,
widgets, overlay-apps), and the component/primitive exports. React/react-dom are
**peer** deps (19.2.7) — the host owns React; plugin view bundles externalise
`@elizaos/ui` + `react` so hooks resolve to the host singleton.

## Layout

```
src/
  index.ts                    Stable primitive root surface; feature APIs are subpath-only
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
  spatial/                    Shared view vocabulary and DOM renderer. `viewType`
                              still accepts future modalities, but this package
                              currently ships only the browser/DOM runtime; the
                              `@elizaos/ui/spatial/tui` subpath is a throwing
                              compatibility seam. See spatial/README.md.
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

The root `@elizaos/ui` export is intentionally limited to stable primitives and
`cn`. Feature consumers use the subpath entries declared in `package.json`:

- `@elizaos/ui/styles` and `@elizaos/ui/styles/*.css` — CSS (renderer-only)
- `@elizaos/ui/cloud-ui`, `@elizaos/ui/cloud-ui/index.css` — Cloud console set
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
bun run --cwd packages/ui typecheck           # tsc --noEmit
bun run --cwd packages/ui test                # vitest (vitest.config.ts)
bun run --cwd packages/ui test:e2e            # slow suite (vitest.e2e.config.ts)
bun run --cwd packages/ui test:agent-surface-e2e   # agent-surface __e2e__ runner
bun run --cwd packages/ui test:chat-sheet-e2e      # chat pull-sheet drag-gesture __e2e__ runner
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

The UI has three complementary layers. Prefer the cheapest layer that can catch a
given class of bug; reach for the heavier ones when behaviour or pixels matter.

1. **Unit / component (`test`, vitest + jsdom).** Co-locate `*.test.tsx` with the
   component. Render with `@testing-library/react`, drive with `user-event`,
   assert on DOM/roles. Setup pins `TZ=UTC`; for clock/RNG-derived UI opt into
   `test/determinism.ts` (`withFrozenClock()`, `withSeededRandom()`) so renders
   are reproducible. Runs in CI via `test:client`.

2. **Story gate (`audit:stories`, `test/story-gate/`).** Renders **every**
   Storybook story in headless Chromium and HARD-fails on a story that throws,
   renders blank, or raises a pageerror; console errors + serious/critical axe
   a11y violations are enforced once their baselines are populated. A determinism
   shim (frozen clock / seeded RNG / en-US-UTC / animations off) makes every
   screenshot byte-stable. App-context-dependent stories are classified soft
   `needs-runtime` (covered live by `audit:app`), not failed. Build the catalog
   first (`build-storybook --output-dir storybook-static`), then run the gate
   when reviewing story or design-system changes. Reusable helpers:
   `determinism-shim.mjs` and `log-capture.mjs`
   (durable frontend console/network artifact, wired per story into
   `output/frontend-logs.json`).

3. **Isolated browser e2e (`test:*-e2e`, `src/**/__e2e__/`).** esbuild-bundle a
   fixture → headless Chromium for gesture/animation/flow coverage no jsdom can
   reach (chat sheet detents, home screen, onboarding, agent surface). Author one
   when a behaviour depends on real layout, pointer events, or timing.

Every new story automatically gains story-gate coverage; a new interactive
component should ship at least a `*.stories.tsx` (states) **and** a `*.test.tsx`
(behaviour). The live full-app visual audit lives in `packages/app`
(`audit:app` and `audit:cloud` in `packages/app`).

### Source gates (vitest, no runtime)

Design-contract gates scan `src` as text and fail on regression; they are the
cheapest layer and run with the normal unit lane:

- `src/no-focus-ring-gate.test.ts` — bans stray focus/ring utilities; pins the
  shell pill's sole indicator.
- `src/no-backdrop-blur-gate.test.ts` — bans backdrop-filter app-wide (#9141).
- `src/brand-token-gate.test.ts` — enforces the black/white/orange brand
  contract found by the dynamic audits (#25901, #26066, #26075, #26117): hard
  ban on blue/purple/cyan utilities (exemptions: code syntax palette, external
  brand colors), hard ban on retired Binance-gold literals and the first-run
  text-support scrim plate, and a DOWN-ONLY ratchet on off-token status
  utilities (`red-*`/`green-*`/`amber-*` → use `status-success`/`destructive`
  tokens). When a burn-down PR cleans a surface, lower the ratchet baseline in
  the same PR; never raise it.

The dynamic complement is the surface-audit workflow (see #26117): rank
Storybook surfaces by composite offender score (rendered contrast, banned
hues, broken states, stray type/spacing), then fix worst-first with the
`better-*` review skills. The gates encode each dynamic finding class once it
is understood, so it can never silently regress.

### Scroll + tap-target certification (`src/testing/scroll-cert.ts`, #14380)

A UI-library-wide certification harness holds every scrollable / interactive
widget to four device-review guarantees: **scroll stability**, **keyboard
interaction geometry**, **safe-area clearance**, and **tap-target minimums**
(44x44 CSS px). It is two layers, same split as the rest of `src/testing`:

- **Pure verdict math** — `scroll-cert.ts` is `(measurements) -> Violation[]`,
  proven both ways (RED on a violation, GREEN when it holds) in
  `scroll-cert.test.ts`. This is the always-trustworthy detector.
- **DOM sweep** — `widget-cert.ts` walks a rendered widget for interactive
  controls + scroll containers, reads their boxes through a pluggable
  `GeometryProvider`, and runs the verdicts into a per-widget `WidgetCertReport`
  (JSON + rendered summary). Under jsdom (`widget-cert.test.tsx`) geometry is
  injected via `mapGeometryProvider`; a real browser supplies
  `liveGeometryProvider` (getBoundingClientRect + getComputedStyle).
- **Deep layer** — `src/testing/__e2e__/run-widget-cert-e2e.mjs`
  (`bun run test:widget-cert-e2e`) mounts the widgets in real Chromium/WebKit
  and runs the SAME sweep against real layout, emitting evidence
  (`output-widget-cert/{widget-cert.json,widget-cert.txt,<engine>.png}`).
  Playwright is flaky in CI — the runner SKIPs (exit 0) if the browser can't
  launch; the vitest static layer is the always-green gate.

**To certify a NEW widget:**

1. Give the widget's scroll container a `data-scroll-cert-scroller` attribute
   (or reuse `#continuous-thread` / `[data-testid="chat-thread"]`), and make sure
   every interactive control is a native control / has a `role` / is
   `tabindex>=0` (the sweep only enforces the tap floor on real controls). A
   control with an expanded hit area (padding / hitSlop) should report an
   effective hit box via the provider; a genuinely non-pointer affordance opts
   out with `data-tap-target="ignore"`.
2. Add a `certifyWidget("my-widget", root, provider, { dimensions: [...] })` case
   to `widget-cert.test.tsx` (static, always runs) — pick the dimensions that
   apply (`scroll`, `tap-target`, `safe-area`, `keyboard`). Inject known-good and
   known-broken geometry so the cert is proven, not just green-because-empty.
3. Optionally add the widget to the deep fixture
   (`__e2e__/widget-cert-fixture.tsx`) so it is also certified against real
   layout when playwright can run.
4. A cert FAILURE is an actionable per-control report (code + selector +
   measurement). This harness only DETECTS — component sizing/layout fixes are
   owned by the component's lane; route findings there.

## Config / env vars

This package mostly reads config injected by the host, not raw env vars:

- `E2E_RECORD=1` with `E2E_RECORDING_DIR=<absolute path>` — sends isolated
  browser-runner artifacts to the canonical repository recording tree. Direct
  runner invocations without the explicit destination keep their fixture-local
  output directory.
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
- **Add a mutating control to a builtin view:** every on-screen mutation in
  `components/pages/`, `components/settings/`, or `components/character/` must
  have a registered agent-action twin ("views display, chat controls" — voice
  has no DOM to click). Prefer adding or extending the semantic action; the generic
  `useAgentElement` bridge is for third-party plugin views only.
- **Add a Cloud console component:** add under `cloud-ui/components/` and export
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
- **Chat turn status is phase-neutral.** `TurnStatus` uses the same neutral
  shimmer and spinner for thinking, tool work, and speaking so transport-phase
  changes do not flash the app accent. Preserve its `motion-reduce` fallback
  when changing the status treatment.
- **Builtin view mutations need semantic action twins.** When adding a
  button/filter/toggle/form handler to a builtin view, add or reuse the owning
  action first; see "Add a mutating control to a builtin view" above.
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

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
