# `scripts/` — build, dev orchestration, tooling

Most scripts here are invoked from **root `package.json`** (`bun run …`). **App and desktop dev entrypoints** (`dev-ui.mjs`, `dev-platform.mjs`, `run-node.mjs`, `desktop-build.mjs`, etc.) live under **`eliza/packages/app-core/scripts/`** so they ship with `@elizaos/app-core`. This README highlights the **desktop dev orchestrator**; deeper rationale lives in the docs site.

## Desktop: `dev-platform.mjs`

| npm script | Entry |
|------------|--------|
| `bun run dev:desktop` | `bun eliza/packages/app-core/scripts/dev-platform.mjs` |
| `bun run dev:desktop:watch` | `ELIZA_DESKTOP_VITE_WATCH=1` + same |

**Why a dedicated script:** Electrobun needs a renderer URL, often a running API, and (in dev) a root `dist/` bundle. Starting each piece by hand drifts on ports and env vars; one orchestrator keeps **startup and shutdown** symmetric.

**Full guide (WHYs for signals, `detached`, HMR vs Rollup watch, multiple `bun` PIDs):** [Desktop local development](../../docs/apps/desktop-local-development.md)

### Production and staging Cloud targets

Desktop builds use production Eliza Cloud by default. To bake the staging
control plane into the renderer, pass the explicit build target:

```bash
node packages/app-core/scripts/desktop-build.mjs build --cloud-only --cloud-target staging
```

CI can set `ELIZA_DESKTOP_CLOUD_TARGET=staging` instead. Accepted values are
`production` and `staging`; any other value fails the build. The staging target
starts from `https://staging.eliza.app`, and the shared domain contract derives
the matching staging API and authenticated Cloud app hosts.

### Bun Version (Windows)

- Recommended: **Bun 1.3.x stable** for `dev:win` flows.
- Canary builds can change ESM/CJS interop behavior. `dev-ui.mjs` prints a startup advisory when it detects canary or non-1.3 Bun.

### Supporting modules (`eliza/packages/app-core/scripts/lib/`)

| Module | Why it exists |
|--------|----------------|
| `vite-renderer-dist-stale.mjs` | Renderer mtime checks, plus opt-in UI-smoke manifest validation, so reusable `apps/app/dist` builds skip redundant multi-minute rebuilds. |
| `kill-ui-listen-port.mjs` | Clears the UI port before Vite binds; Unix uses `lsof`, Windows uses `netstat` + `taskkill` because `lsof` is not standard there. |
| `kill-process-tree.mjs` | Kills **only** the PID tree rooted at each spawned child — avoids `pkill bun` style collateral damage to other workspaces. |

### Process supervision split

`dev-ui.mjs`, `dev-platform.mjs`, `dev-all.mjs`, and
`packages/scripts/run-all-tests.mjs` intentionally do not share one generic
child-process supervision helper. Their lifecycle contracts differ enough that a
shared helper would mostly be flags for incompatible behavior. The in-tree
rationale is tracked in
[`packages/scripts/process-supervision.md`](../../scripts/process-supervision.md).
