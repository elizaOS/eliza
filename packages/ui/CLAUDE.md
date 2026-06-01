# @elizaos/ui

Shared React UI library for elizaOS apps: primitives, composites, layouts, the
agent dashboard shell (`App.tsx`), the typed HTTP/WS API client, agent-surface
view instrumentation, GenUI, voice, and platform/bridge glue.

## Purpose / role

A single design-system + runtime-glue package consumed by every elizaOS
front-end and by plugin UIs. Importers include `@elizaos/app` (web + desktop
shell), `@elizaos/app-core`, `@elizaos/cloud-frontend`, `@elizaos/os-homepage`,
the `eliza-app` homepage, and many plugin UI packages (`plugin-wallet-ui`,
`plugin-companion`, `plugin-messages`, `plugin-training`, `plugin-feed`, etc.).
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
    primitives/  ui/          Base primitives (button, switch, tabs, textarea, ...)
    composites/               Higher-level pieces (sidebar, page-panel, ...)
    shell/                    ChatSurface, AssistantOverlay, HomePill, shell-state reducer
    apps/                     Overlay/game app surfaces + registries + AppWindowRenderer
    character/ chat/ config-ui/ pages/ settings/ steward/ voice/ voice-pill/ ...
  cloud-ui/                   Cloud-frontend component set (@elizaos/ui/cloud-ui):
                              dashboard, docs, data-list, monetization, analytics, ai-elements,
                              theme provider, runtime shims (dynamic/Image/navigation). Own index.css
  config/                     Boot config, branding, plugin-config UI-spec engine
                              (buildPluginConfigUiSpec, evaluateVisibility, validators, catalogs)
  genui/                      Agent-generated UI (A2UI-compatible subset): validator,
                              renderer, actions, streaming. See genui/README.md
  navigation/                 Tab model + default-landing resolution (resolveDefaultLandingTab)
  layouts/                    page-layout, content-layout, chat-panel-layout, workspace-layout
  services/                   Client-side services: local-inference (model catalog,
                              downloader, engine, assignments), app-updates
  homescreen/                 Homescreen canvas + scene apply/history + face-rig
  backgrounds/                Background host + registry (BackgroundHost, CloudVideoBackground)
  companion/                  Companion bar (desktop) — CompanionBar, push-to-talk
  views/                      View event bus + interact protocol (STANDARD_CAPABILITIES)
  hooks/                      ~35 hooks (useMediaQuery, useActivityEvents, useRenderGuard, ...);
                              many more use* hooks live alongside their features
  widgets/                    Chat sidebar widget registry + WidgetHost + visibility
  themes/                     apply-theme, presets
  voice/                      Voice capture factory, character voice config, local ASR
  avatar-runtime/             VRM avatar host + registry + presets
  events/                     Custom DOM event names + dispatch helpers (APP_EMOTE_EVENT, ...)
  i18n/                       UiLanguage, message catalogs, region helpers
  first-run/                  Deep-link routing, first-run config, pre-seed local runtime
  content-packs/              Content pack load/apply (bundled-packs)
  providers/                  AI provider logo registry (getProviderLogo, registerProviderLogo)
  utils/  lib/                Formatters, SQL helpers, rate limiters, cn(), floating-layers z-index
  slots/                      Plugin slot components (task-coordinator-slots)
  styles/  stories/             CSS modules, story fixtures
test/                           Test stubs (top-level, not under src/)
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
- `@elizaos/ui/platform`, `@elizaos/ui/providers`, `@elizaos/ui/types`, `@elizaos/ui/utils`
- `@elizaos/ui/app-shell-registry`, `@elizaos/ui/button`, `@elizaos/ui/card`,
  `@elizaos/ui/input`, `@elizaos/ui/dropdown-menu` — direct-component shortcuts

Registries plugins/hosts call at runtime: `registerAppShellPage` (nav tabs),
`registerProviderLogo` (provider logos), the overlay-app and game-surface
registries under `components/apps/`, the widget `registry-store`, and
`useAgentElement` for agent-controllable view elements.

## Commands

This is a library — no dev server (use the host app's). Scripts from package.json:

```bash
bun run --cwd packages/ui build               # build:dist → dist/ (locked tsc + asset copy)
bun run --cwd packages/ui typecheck           # generate:css-strings + tsgo --noEmit
bun run --cwd packages/ui test                # vitest (vitest.config.ts)
bun run --cwd packages/ui test:e2e            # slow suite (vitest.e2e.config.ts)
bun run --cwd packages/ui test:agent-surface-e2e   # agent-surface __e2e__ runner
bun run --cwd packages/ui lint                # biome check src
bun run --cwd packages/ui lint:fix            # biome check --write src
bun run --cwd packages/ui format / format:fix # biome format
bun run --cwd packages/ui generate:css-strings # regenerate CSS-as-string modules
bun run --cwd packages/ui stories:dev         # Vite stories (stories/vite.config.ts)
bun run --cwd packages/ui clean
```

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
- **Add a primitive:** add under `components/primitives/` or `components/ui/`,
  re-export via `components/primitives/index` / the existing barrel.
- **Add a nav tab at runtime:** call `registerAppShellPage(registration)`
  (`app-shell-registry.ts`) from the host/plugin; the shell + `navigation/`
  pick it up.
- **Make a view agent-controllable:** use `useAgentElement` — see
  `src/agent-surface/README.md` for ids/roles/controlled-component rules.
- **Add a cloud-frontend component:** add under `cloud-ui/components/` and export
  from `cloud-ui/index.ts`; it ships under the `@elizaos/ui/cloud-ui` subpath.

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
- `ConnectionStatus` exists twice (cloud-ui string union vs. the composite
  component) — the cloud-ui one is intentionally NOT re-exported from the root
  barrel to avoid the collision (see comment in `index.ts`).
- Type root `src/types/index.ts` re-exports from `@elizaos/shared/types`; keep
  shared transport/domain types there rather than redefining them here.
- Build/test conventions and the repo-wide architecture rules live in the root
  AGENTS.md — don't restate them; follow them.
