# @elizaos/plugin-vector-browser

A developer/system app plugin that contributes the **Vector Browser** view: an
in-browser surface for browsing agent memories and visualising their embeddings
as a list, a 2D canvas projection, and a 3D (three.js / WebGL) point cloud. The
heavy three.js surface is shipped as a dynamically loaded view bundle so neither
the component nor `three` ships in the always-loaded `@elizaos/ui` bundle.

## Layout / exports

- `src/index.ts` — barrel. Re-exports the views, the plugin, the snapshot types,
  and the terminal registration helpers.
- `src/plugin.ts` — `vectorBrowserPlugin` (`Plugin`). Declares the single
  `views[]` entry (`id: "vector-browser"`, `developerOnly`, modalities
  `gui` (only the GUI modality ships; `tui`/`xr` remain compatibility values in
  the manifest schema), `componentExport: "VectorBrowserView"`, served at
  `/vector-browser`).
- `src/register.ts` (export `./register`, also `appRegister` in
  `package.json`) — side-effect module. Calls `registerAppRoutePluginLoader` so
  the agent can resolve `Plugin.views` and serve
  `/api/views/vector-browser/bundle.js`. In a terminal host (`window`
  undefined) it lazily registers the spatial terminal view.
- `src/VectorBrowserView.tsx` — the rich GUI surface
  (`VectorBrowserView`, `VectorBrowserRichView`, `VectorGraph3D`). Loads `three`
  and queries memory tables via `@elizaos/ui/api`'s `client`.
- `src/VectorBrowserSpatialView.tsx` — purely presentational spatial
  fallback (`VectorBrowserSpatialView`) plus the `VectorBrowserPoint` /
  `VectorBrowserSnapshot` types. Imports only `@elizaos/ui/spatial` primitives,
  so it is safe to render inside the Node agent process (no three.js).
- `test/` — `VectorBrowserView.test.tsx`, `VectorGraph3D.test.tsx`, the
  `vector-browser-parser.contract.test.ts`, and `ui-stubs/` (per-specifier no-op
  stubs for `@elizaos/ui` subpaths that vitest's resolver can't resolve).

Exports map (`package.json`): `.` (barrel), `./plugin`, `./register`, `./*.css`,
and `./*`. Build output goes to `dist/` (including `dist/views/bundle.js`).

## Key scripts (scope with `--cwd`)

```bash
bun run --cwd plugins/plugin-vector-browser build      # build:js + build:views (vite) + build:types
bun run --cwd plugins/plugin-vector-browser typecheck  # tsgo --noEmit
bun run --cwd plugins/plugin-vector-browser test       # vitest run (vitest.config.ts)
bun run --cwd plugins/plugin-vector-browser clean      # remove dist
```

`build` is three steps: `build:js` (tsup, shared plugin config), `build:views`
(`vite build` with `vite.config.views.ts`), and `build:types` (`tsc --noCheck`).

## Conventions / gotchas

- **Lazy WebGL by design.** Registration adds no eager three.js cost — the view
  bundle (and `three`) is only fetched when the view is actually mounted. Don't
  import `three` or the rich view from an always-loaded path.
- **One declaration.** The GUI `Escape` fallback renders the
  `VectorBrowserSpatialView` summary-stats + points-list when the rich WebGL
  surface cannot mount. Keep the spatial view free of heavy client / three.js /
  `@elizaos/ui` shell-host imports.
- **Test resolver aliases.** `vitest.config.ts` aliases each `@elizaos/ui`
  subpath the view imports to its own distinct no-op stub (vitest dedupes mocks
  by resolved path, so stubs must be separate files); the parser/layout module
  and the spatial barrel are aliased to real `packages/ui/src` source so contract
  tests exercise the real implementation.
- `peerDependencies` requires `react >=18`; `react` / `three` / `@types/*` are
  devDependencies. Runtime deps are `@elizaos/core`, `@elizaos/shared`,
  `@elizaos/ui`, `lucide-react`. No env vars.
- A host runtime can override the renderer via `getBootConfig().companionVectorBrowser`
  (`THREE` + `createVectorBrowserRenderer`); the default lazily imports `three`
  and prefers a WebGPU renderer when `navigator.gpu` is available.

Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../AGENTS.md).

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
