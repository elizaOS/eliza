# @elizaos/ui Storybook

A real Storybook (`@storybook/react-vite`) catalog for the UI component library,
so components can be developed and tested in isolation.

```bash
bun run --cwd packages/ui storybook        # dev catalog at http://localhost:6006
bun run --cwd packages/ui build-storybook  # static build
```

## How it's wired

- `main.ts` — stories glob (`src/**/*.stories.tsx` + plugin-companion), addons
  (docs/a11y/themes), and a `viteFinal` that mirrors `vitest.config.ts`:
  the `@tailwindcss/vite` plugin (the UI is Tailwind v4 — without it utilities
  never generate and components paint invisible), the `@elizaos/*` source
  aliases + react/react-dom dedupe, the `process.env` shim, and Node-builtin
  stubs (see below).
- `preview.tsx` — imports `@elizaos/ui/styles` and a light/dark theme toggle.
- `src/storybook/mock-providers.tsx` — `mockApp(overrides)` decorator factory +
  `withMockApp`. Provides a mock `AppContext` so the ~100 components that call
  `useApp()` render in isolation. **Must live under `src/`** (not here in the
  config dir): a decorator imported from `.storybook/` does not share the
  preview's module graph / react dedupe and silently breaks rendering.
- `test/stubs/node-fs.ts` — browser no-op stub for `node:fs` / `node:fs/promises`.
  The `local-inference` services (reachable from the state graph that
  `useApp()` components import) use these Node builtins; the catalog never runs
  those services, so the stub just lets the imports resolve.

## Known limitations (tracked — not ignored)

1. **`build-storybook` may OOM/panic in resource-constrained environments** while
   bundling the full `@elizaos/core` source graph (no prebuilt `dist`). `storybook
   dev` compiles on-demand and works. A prebuilt core (`bun run build`) makes the
   static build viable.
2. **State/context-heavy stories that reach `useApp` → `AppContext` → services
   can still render blank.** Stories whose import graph transitively pulls the
   app services layer (via `useApp` → `AppContext` → services, or the
   `api`/`utils`/`voice` graph) can drag Node builtins into the browser bundle
   and render empty. Confirmed blank on a warm server: `Composites/Chat/PermissionCard`,
   `Composites/Chat/ContinuousChatToggle`, and the shell state stories
   (`Shell/CommandPalette`, `Shell/SystemWarningBanner`,
   `Shell/ConnectionFailedBanner`, `Shell/RestartBanner`, `Shell/LoadingScreen`,
   `Shell/ShortcutsOverlay`, `Shell/PairingCommandHint`). They are valid CSF +
   Biome-clean; a populated `AppContext` test harness is the remaining work for
   these. (This is the `useApp` services graph, **not** the `@elizaos/core`
   value-import path, which is resolved — see (3).) The purely-presentational
   majority of the catalog (primitives, most composites, icons, layouts, the
   continuous-chat overlay + glass-composer) renders today — verified serially
   via Playwright. NOTE: a story rendering "empty" can also be correct by
   design — e.g. `Composites/OwnerBadge` `NotOwner` is intentionally hidden for
   non-owners (the `Default`/owner story renders).
3. **RESOLVED (elizaOS/eliza#8177): `@elizaos/core`-coupled feature-surface
   stories now render.** The blocker was that components transitively
   `import { logger } from "@elizaos/core"` via
   `state/TranslationContext` → `state/persistence` — which every
   `useTranslation()` component hits — dragging in core's **Node** entry
   (`features/plugin-manager` → `fs-extra`/`graceful-fs` monkey-patching
   `fs.close` at module-eval, plus `process.cwd()` at eval). Against the
   browser's read-only `fs` stub that threw `Cannot set property close …` and
   the misleading `Cannot convert a Symbol value to a string`.

   The fix (option (c) above): `state/persistence` now imports `logger` from
   `@elizaos/logger` — a browser-safe **leaf** package — instead of
   `@elizaos/core`, so the i18n graph no longer reaches core's Node entry at
   all. `.storybook/main.ts` additionally aliases `@elizaos/core` →
   `index.browser.ts`, stubs `node:fs` / `node:fs/promises` / `fs-extra` /
   `node:child_process`, and shims `process.*` members, so any *other* path into
   core stays browser-safe too. With both in place the optimizer no longer
   pulls `fs-extra` through the i18n surface.

   The 11 previously held-back wave-4 stories now ship and are render-verified
   on a warm `storybook dev` server (zero `Symbol`/`fs-extra`/`browser-external`
   errors): `apps/{RunningAppsRow,AppIdentity}`,
   `local-inference/{ActiveModelBar,DownloadProgress,ModelUpdatesPanel}`,
   `policy-controls/{PolicyToggle,RateLimitSection,SpendingLimitSection,`
   `AutoApproveSection,TimeWindowSection,ApprovedAddressesSection}`. The
   i18n-driven panels wrap a `TranslationProvider` decorator (they call
   `useTranslation()`); the `apps/*` tiles need no provider. The earlier-shipped
   presentational wave-4 stories remain: `permissions/PermissionIcon`,
   `views/ViewIcon`, `shared/ThemeToggle`, `shared/AppPageSidebar`. (A
   `voice/VoiceWaveform` story was also shipped, but its component was later
   removed on `develop` in a perf pass — "kill VoiceWaveform" — so the orphaned
   story was dropped when this branch merged `develop`.)

## Tracked test follow-ups (not ignored)

- **`ContinuousChatOverlay`** — covered by `ContinuousChatOverlay.test.tsx` (pure
  component, mock controller).
- **Header-less shell** (`hideComposer`, no mounted `Header`, no primary nav bar,
  gating) — covered at the source-invariant level in `App.cloud-shell.test.tsx`.
  Navigation is conversational (the ambient chat overlay + command palette); the
  end-to-end chat behavior (overlay is the chat input; in-view composer hidden)
  was verified live via Playwright against a running agent.
- **Deferred:** an isolated render test for `ChatView` (with `hideComposer`)
  needs a richer `AppProvider` test harness — it reads the full app context
  (e.g. `messages` must be iterable), so a bare render throws. Worth a shared
  `renderWithAppContext(...)` helper that seeds a complete mock
  `AppContextValue`; tracked, not blocking.
