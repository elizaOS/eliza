# `scripts/` — build, dev orchestration, tooling

Most scripts here are invoked from **root `package.json`** (`bun run …`). **App and desktop dev entrypoints** (`dev-ui.mjs`, `dev-platform.mjs`, `run-node.mjs`, `desktop-build.mjs`, etc.) live under **`eliza/packages/app-core/scripts/`** so they ship with `@elizaos/app-core`. This README highlights the **desktop dev orchestrator**; deeper rationale lives in the docs site.

## Desktop: `dev-platform.mjs`

| npm script | Entry |
|------------|--------|
| `bun run dev:desktop` | `bun eliza/packages/app-core/scripts/dev-platform.mjs` |
| `bun run dev:desktop:watch` | `ELIZA_DESKTOP_VITE_WATCH=1` + same |

**Why a dedicated script:** Electrobun needs a renderer URL, often a running API, and (in dev) a root `dist/` bundle. Starting each piece by hand drifts on ports and env vars; one orchestrator keeps **startup and shutdown** symmetric.

**Full guide (WHYs for signals, `detached`, HMR vs Rollup watch, multiple `bun` PIDs):** [Desktop local development](../docs/apps/desktop-local-development.md)

### Bun Version (Windows)

- Recommended: **Bun 1.3.x stable** for `dev:win` flows.
- Canary builds can change ESM/CJS interop behavior. `dev-ui.mjs` prints a startup advisory when it detects canary or non-1.3 Bun.

### Supporting modules (`eliza/packages/app-core/scripts/lib/`)

| Module | Why it exists |
|--------|----------------|
| `vite-renderer-dist-stale.mjs` | Cheap mtime check so `vite build` is skipped when `apps/app/dist` is still fresh — avoids redundant multi‑minute production builds on restart. |
| `kill-ui-listen-port.mjs` | Clears the UI port before Vite binds; Unix uses `lsof`, Windows uses `netstat` + `taskkill` because `lsof` is not standard there. |
| `kill-process-tree.mjs` | Kills **only** the PID tree rooted at each spawned child — avoids `pkill bun` style collateral damage to other workspaces. |

## Mobile: `run-mobile-build.mjs`

`run-mobile-build.mjs` is the canonical Android/iOS build policy entry.
It resolves each target through `resolveMobileBuildPolicy()` and stamps
the shared renderer env with `resolveMobileBuildEnv()`, including
`VITE_ELIZA_MOBILE_RUNTIME_MODE`.

The store targets are fail-closed:

- `android-cloud` is a Play Store thin client. It disables global
  cleartext, strips local runtime assets, and removes native plugins that
  can expose the on-device agent surface.
- `ios` is an App Store cloud-hybrid build. It keeps the no-JIT local
  runtime path when the full Bun engine is present, but foreground
  traffic goes through `eliza-local-agent://ipc` and native IPC, not a
  WebView-visible localhost listener.

For local/sideload targets, the UI may keep a stable local-agent identity
for persisted profiles, but new mobile API paths should be implemented
behind the Capacitor/native bridge (`Agent.request` on Android,
`ElizaBunRuntime.call("http_request")` on iOS). Do not add direct
renderer fetches to `127.0.0.1:31337` as a mobile dependency.
