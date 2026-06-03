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
2. **State/context-heavy stories render blank pending the harness in (3)/#8177.**
   Stories whose import graph transitively reaches `@elizaos/core` / the app
   services layer (via `useApp` → `AppContext` → services, or via the
   `api`/`utils`/`voice` graph) pull Node builtins into the browser bundle and
   render empty — the **same root cause as (3)**, not merely a slow compile.
   Confirmed blank on a warm server: `Composites/Chat/PermissionCard`,
   `Composites/Chat/ContinuousChatToggle`, and the shell state stories
   (`Shell/CommandPalette`, `Shell/SystemWarningBanner`,
   `Shell/ConnectionFailedBanner`, `Shell/RestartBanner`, `Shell/LoadingScreen`,
   `Shell/ShortcutsOverlay`, `Shell/PairingCommandHint`). They are valid CSF +
   Biome-clean; populated rendering is gated on the #8177 harness work. The
   purely-presentational majority of the catalog (primitives, most composites,
   icons, layouts, the continuous-chat overlay + glass-composer) renders today —
   verified serially via Playwright. NOTE: a story rendering "empty" can also be
   correct by design — e.g. `Composites/OwnerBadge` `NotOwner` is intentionally
   hidden for non-owners (the `Default`/owner story renders).
3. **Feature-surface stories coupled to `@elizaos/core` can't render in the
   browser catalog yet** (tracked: elizaOS/eliza#8177). Components that
   transitively `import { logger } from
   "@elizaos/core"` drag in core's **Node** entry. The clearest path is
   `state/TranslationContext` → `state/persistence` (`import { logger } from
   "@elizaos/core"`), which every `useTranslation()` component hits — i.e. the
   i18n-driven `policy-controls/*` and `local-inference/*` panels, plus the
   `apps/*` model-hub surfaces. Two layered causes:
   - Vite's **dependency optimizer ignores `resolve.alias`** and resolves bare
     `@elizaos/core` via package.json `exports` → the **Node** build
     (`src/index.node.ts`), not the browser entry. (Aliasing core →
     `index.browser.ts` fixes on-demand transforms but not the pre-bundle pass.)
   - The Node entry pulls `features/plugin-manager`, which (a) calls
     `process.cwd()` at module-eval and (b) imports `fs-extra`/`graceful-fs`
     that monkey-patch `fs.close` at eval. The patch throws `Cannot set property
     close … which has only a getter` against a read-only ESM `fs` stub (and
     `String(symbol)` inside Vite's `browser-external` proxy throws the
     misleading `Cannot convert a Symbol value to a string`).

   A browser-entry alias + an ambient `process` shim (preview `<head>` script) +
   Node-builtin stubs in **both** the Vite plugin and the optimizer's esbuild
   pass clear the `process.cwd` and Symbol-coercion classes, but the `fs-extra`
   patch persists because `fs-extra` still reaches the optimizer graph through
   core's Node entry. A proper fix needs one of: (a) core's **browser** entry to
   be genuinely free of the `plugin-manager`/`fs-extra` graph **and** the
   optimizer to resolve `@elizaos/core` → that entry (a dedicated
   `optimizeDeps.esbuildOptions` resolver, since alias is ignored there); (b) a
   mutable CJS `fs` stub `graceful-fs` can patch without throwing; or (c)
   decoupling `state/persistence` from a value import of `@elizaos/core`
   (import `logger` from a lighter, browser-safe entry).

   Until that harness lands, the affected wave-4 stories
   (`apps/{RunningAppsRow,AppIdentity}`,
   `local-inference/{ActiveModelBar,DownloadProgress,ModelUpdatesPanel}`,
   `policy-controls/{PolicyToggle,RateLimitSection,SpendingLimitSection,`
   `AutoApproveSection,TimeWindowSection,ApprovedAddressesSection}`) are held
   back rather than shipped broken. The purely-presentational wave-4 stories
   that don't touch that graph **are** committed and render-verified:
   `permissions/PermissionIcon`, `views/ViewIcon`, `shared/ThemeToggle`,
   `shared/AppPageSidebar`. (A `voice/VoiceWaveform` story was also shipped, but
   its component was later removed on `develop` in a perf pass — "kill
   VoiceWaveform" — so the orphaned story was dropped when this branch merged
   `develop`.)

## Tracked test follow-ups (not ignored)

- **`ContinuousChatOverlay`** — covered by `ContinuousChatOverlay.test.tsx` (pure
  component, mock controller).
- **`MINIMAL_SHELL`** — covered by `shell-chrome.test.ts`.
- **Chat-shell wiring** (`hideComposer`, header nav, 3-panel restore, gating) —
  covered at the source-invariant level in `App.cloud-shell.test.tsx`, and the
  end-to-end behavior (overlay is the chat input; in-view composer hidden; nav
  renders) was verified live via Playwright against a running agent.
- **Deferred:** isolated render tests for `ChatView` (with `hideComposer`) and
  `Header` (nav/tab-groups) need a richer `AppProvider` test harness — these
  components read the full app context (e.g. `messages` must be iterable), so a
  bare render throws. Worth a shared `renderWithAppContext(...)` helper that
  seeds a complete mock `AppContextValue`; tracked, not blocking.
