---
title: "Plugin Resolution and NODE_PATH"
sidebarTitle: "Plugin Resolution"
description: "Why dynamic plugin imports fail without NODE_PATH and how Eliza fixes it across CLI, dev server, and Electrobun."
---

# Plugin resolution: why NODE_PATH is needed

This doc explains **why** dynamic plugin imports fail without `NODE_PATH` and **how** we fix it across CLI, dev server, and Electrobun.

> **Note:** The source files referenced in this document live in the elizaOS submodule (`eliza/`). Run `bun run setup:upstreams` to populate the submodule so you can inspect them locally. All paths like `src/runtime/eliza.ts` refer to `eliza/packages/app-core/src/runtime/eliza.ts` unless otherwise noted.

## The problem

The runtime (`src/runtime/eliza.ts`) loads plugins via dynamic import:

```ts
import("@elizaos/plugin-sql")
```

Node resolves this by walking up from the **importing file's directory**. When eliza runs from different locations, resolution can fail:

| Entry point | Importing file location | Walks up from | Reaches root `node_modules`? |
|---|---|---|---|
| `bun run dev` | `src/runtime/eliza.ts` | `src/runtime/` | Usually yes (2 levels) |
| `eliza start` (CLI) | `dist/runtime/eliza.js` | `dist/runtime/` | Usually yes (2 levels) |
| Electrobun dev | `eliza-dist/eliza.js` | `apps/app/electrobun/eliza-dist/` | **No** — walks into `apps/` |
| Electrobun packaged | `app.asar.unpacked/eliza-dist/eliza.js` | Inside the `.app` bundle | **No** — different filesystem |

In the Electrobun cases (and sometimes the built dist case depending on bundler behavior), the walk never reaches the repo root where `@elizaos/plugin-*` packages are installed. The import fails with "Cannot find module".

## The fix: NODE_PATH

`NODE_PATH` is a Node.js environment variable that adds extra directories to module resolution. We set it in **three places** so every entry path resolves plugins:

### 1. `src/runtime/eliza.ts` (module-level)

```ts
const _repoRoot = path.resolve(_elizaDir, "..", "..");
const _rootModules = path.join(_repoRoot, "node_modules");
if (existsSync(_rootModules)) {
  process.env.NODE_PATH = ...;
  Module._initPaths();
}
```

**Why here:** Covers `bun run dev` (dev-server.ts imports eliza directly) and any other in-process import of eliza. The `existsSync` guard means this is a no-op in packaged apps where the repo root doesn't exist.

**Note on `Module._initPaths()`:** It is a private Node.js API but widely used for exactly this purpose (runtime NODE_PATH mutation). Node caches resolution paths at startup; after we set `process.env.NODE_PATH` we must call it so the next `import()` sees the new paths.

### 2. `eliza/packages/app-core/scripts/run-node.mjs` (child process env)

```js
const rootModules = path.join(cwd, "node_modules");
env.NODE_PATH = ...;
```

**Why here:** The CLI runner spawns a child process that runs `eliza.mjs` → `dist/entry.js` → `dist/eliza.js`. Setting `NODE_PATH` in the child's env ensures the child resolves from root even though `dist/` doesn't have its own `node_modules`.

### 3. `eliza/packages/app-core/platforms/electrobun/src/native/agent.ts` (Electrobun native runtime)

```ts
// Dev: walk up from __dirname to find node_modules
// Packaged: use ASAR node_modules
```

**Why here:** The Electrobun native runtime loads `eliza-dist/eliza.js` via `dynamicImport()`. In dev mode, `__dirname` is deep inside `apps/app/electrobun/build/src/native/` — we walk up to find the first `node_modules` directory (the monorepo root). In packaged mode, we use the ASAR's `node_modules` instead.

## Why not just use the bundler?

tsdown with `noExternal: [/.*/]` inlines most dependencies, but `@elizaos/plugin-*` packages are loaded via **runtime dynamic import** (the plugin name comes from config, not a static import). The bundler can't inline them because it doesn't know which plugins will be loaded. They must be resolvable at runtime.

## Packaged app: no-op

In the packaged `.app`, `eliza.js` lives at `app.asar.unpacked/eliza-dist/eliza.js`. Two levels up is `Contents/Resources/` — no `node_modules` there. The `existsSync` check in `eliza.ts` returns false, so the NODE_PATH code is skipped entirely. The packaged app instead copies runtime packages into `eliza-dist/node_modules` during the desktop build (`copy-runtime-node-modules.ts` for Electrobun) and `agent.ts` sets that packaged `node_modules` directory on `NODE_PATH`.

## Bun and published package exports

Some `@elizaos` packages (e.g. `@elizaos/plugin-sql`) publish a `package.json` with `exports["."].bun = "./src/index.ts"`. **Why they do that:** In the upstream monorepo, Bun can run TypeScript directly, so pointing to `src/` avoids a build step. The published npm tarball, however, only includes `dist/` — `src/` is not shipped. When we install from npm, the `"bun"` condition points to a path that does not exist.

**What happens:** Bun's resolver prefers the `"bun"` export condition. It tries to load `./src/index.ts`, the file is missing, and we get "Cannot find module … from …/src/runtime/eliza.ts" even though the package is in `node_modules`. Bun does not fall back to the `"import"` condition when the `"bun"` target is missing.

**Our fix:** `eliza/packages/app-core/scripts/patch-deps.mjs` runs after `bun install` via `eliza/packages/app-core/scripts/run-repo-setup.mjs` (invoked from Eliza's `postinstall` entry at `scripts/eliza-postinstall-repo-setup.mjs`). It finds affected `@elizaos` packages (including any we add to the allowlist) and, if `exports["."].bun` points to `./src/index.ts` and that file does not exist, removes the `"bun"` and `"default"` conditions that reference `src/`. After the patch, only `"import"` (and similar) remain, so Bun resolves to `./dist/index.js`. **Why we only patch when the file is missing:** In a development workspace where the plugin is checked out with `src/` present, we leave the package unchanged so upstream workflows still work.

## Pinned: `@elizaos/plugin-openrouter`

This repo currently resolves **`@elizaos/plugin-openrouter`** via a local
workspace link (**`workspace:*`**) during development. When not using the local
checkout, the root `package.json` pins **`2.0.0-alpha.13`** (the current known-good
npm tarball). **`2.0.0-alpha.12`** shipped broken dist entrypoints and must be avoided.

### What went wrong in `2.0.0-alpha.12`

The published npm tarball for **`2.0.0-alpha.12`** contains **truncated** JavaScript outputs for the Node ESM and browser entrypoints (`dist/node/index.node.js`, `dist/browser/index.browser.js`). Those files only include the bundled `utils/config` helpers (~80 lines). The **main plugin implementation** (the object that should be exported as `openrouterPlugin` and as `default`) is **not present** in the file, but the final `export { … }` list still names `openrouterPlugin` and `openrouterPlugin2 as default`.

**Why Bun errors:** When the runtime loads the plugin, Bun builds/transpiles that entry file and fails with errors like *`openrouterPlugin` is not declared in this file* — the symbols are exported but never defined. The CommonJS build (`dist/cjs/index.node.cjs`) is incomplete in the same way (export getters reference a missing `import_plugin` chunk).

**Why we do not postinstall-patch the dist:** The broken release is missing the
entire plugin body, not a single wrong identifier (contrast
`@elizaos/plugin-pdf`, where a small string replace fixes a bad export alias).
Reconstructing the plugin from source inside Eliza would fork upstream and be
fragile. When you are not using the local workspace checkout, prefer the known
good published **`2.0.0-alpha.13`** artifact.

### Maintainer notes

- **Before bumping** the OpenRouter dependency, verify the **published tarball** on npm: open `dist/node/index.node.js` and confirm it defines the default export / `openrouterPlugin`, or run `bun build node_modules/@elizaos/plugin-openrouter/dist/node/index.node.js --target=bun` after install.
- **Do not replace the workspace link with an unfenced semver range** until upstream publishes a fixed version and you have confirmed the artifact. **Why:** `^2.0.0-alpha.10` allowed Bun to resolve **`alpha.12`**, which broke installs that upgraded the lockfile.

User-facing context and configuration for OpenRouter itself live in **[OpenRouter plugin](plugin-registry/llm/openrouter.md)** (Mintlify: `/plugin-registry/llm/openrouter`).

## Optional plugins: why was this package in the load set?

Optional plugins (and some core-adjacent packages) can end up in the load set because of **`plugins.allow`**, **`plugins.entries`**, **connector** configuration, **`features.*`**, **environment variables** (e.g. provider API keys or wallet keys that trigger auto-enable), or **`plugins.installs`**. When resolution fails with **missing npm module** or **missing browser stagehand**, the log used to look like a generic runtime error.

**Why we record provenance:** `collectPluginNames()` optionally fills a **`PluginLoadReasons`** map (first source wins per package). `resolvePlugins()` passes it through; benign optional failures are summarized as **`Optional plugins not installed: … (added by: …)`**. That answers “what should I change?” — edit config, unset env, install the package, or add a plugin checkout — instead of chasing a false “eliza is broken” hypothesis.

**Browser / stagehand:** `@elizaos/plugin-browser` expects a **stagehand-server** tree that is **not** in the npm tarball. Eliza discovers `plugins/plugin-browser/stagehand-server` by **walking parents** from the runtime so both flat Eliza checkouts and **`eliza/` submodule** layouts resolve. See **[Developer diagnostics and workspace](guides/developer-diagnostics-and-workspace.md)**.

## Pack-and-test and Vendored Workspace Validation (Phase 5)

As part of the Plugin Workspace architecture, we load dependencies via `workspace:*` out of the vendored source tree (`eliza/packages/*` and `eliza/plugins/*`). Sometimes, you need to verify that what works in a `workspace:*` context will successfully pack into tarballs and install strictly downstream as if published.

We provide two scripts to validate and prevent drift:

### `scripts/pack-upstreams.mjs`
To simulate a real publish release locally, run `node scripts/pack-upstreams.mjs`. It iterates over the target vendored packages (currently `@elizaos/core`, which now includes the orchestrator runtime, plus one representative vendored plugin: `@elizaos/plugin-sql`), builds them when needed, runs `npm pack`, and places the resulting `.tgz` artifacts in the root `artifacts/` directory.

### `scripts/check-upstream-drift.mjs`
To ensure that root-level explicitly pinned dependencies (e.g., `"@elizaos/plugin-openrouter": "2.0.0-alpha.13"`) do not drift from the source code checked into the vendored trees, run `node scripts/check-upstream-drift.mjs`. The command inspects root pins against the `package.json` inside local vendor trees and fails if their explicitly pinned specifications diverge from source.

### `scripts/sync-upstream-versions.mjs`
This is a compatibility alias for the same drift check used by older sprint tickets. Run `node scripts/sync-upstream-versions.mjs` if you want the legacy script name; it exits with the same green/red verdict as `check-upstream-drift`.

### Vendored Source Verification (Proof of Life)
Because all packages resolve via `workspace:*`, local modifications are live the moment you restart `bun run dev`.
**Example proof-of-life workflow**:
1. Open `eliza/packages/core/src/index.ts` (`@elizaos/core`) and add a `console.log("Hello from vendored core!");`.
2. Open `eliza/plugins/plugin-sql/src/index.ts` and add `console.log("Hello from vendored plugin!");`.
3. Run `bun run dev` at the root.
4. You will immediately see both logs without needing `npm link`, custom `NODE_PATH` patches, or cache-busting. The changes are resolved automatically by Bun workspaces.
