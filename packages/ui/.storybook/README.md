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
2. **State/context-heavy stories are slow to first-compile.** Stories that import
   the full app state graph (anything pulling `useApp` → `AppContext` → services)
   trigger a large on-demand compile; first load can exceed a headless probe's
   timeout in constrained sandboxes. They render on a warm/resourced server.
   Affected so far: `Shell/CommandPalette`, `Shell/SystemWarningBanner`,
   `Shell/ConnectionFailedBanner`, `Shell/RestartBanner`, `Shell/LoadingScreen`,
   `Shell/ShortcutsOverlay`, `Shell/PairingCommandHint`,
   `Composites/Chat/ContinuousChatToggle`, `Composites/Chat/PermissionCard`.
   These are valid CSF + Biome-clean + correctly wired (mock state via
   `mockApp({...})`); render-verification is pending a resourced build.
