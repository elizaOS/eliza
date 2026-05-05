---
title: Developer diagnostics and workspace tooling
---

# Developer diagnostics and workspace tooling (WHYs)

This guide is for **people building Eliza from source** — editors, agents, and maintainers. It explains **why** recent developer-facing behavior exists so you can debug faster without mistaking optional noise for product bugs.

## Plugin load reasons (optional plugins)

**Problem:** Logs like `Cannot find module '@elizaos/plugin-solana'` or “browser server not found” looked like the runtime was broken, when often the real issue was **config or env** pulling a plugin into the load set while the package or native binary was never installed.

**Why we trace provenance:** `collectPluginNames()` can record the **first** source that added each package (for example `plugins.allow["@elizaos/plugin-solana"]`, `env: SOLANA_PRIVATE_KEY`, `features.browser`, `CORE_PLUGINS`). `resolvePlugins()` passes that map through resolution; when an **optional** plugin fails for a benign reason (missing npm module, missing stagehand), the summary log includes **`(added by: …)`** so you know whether to edit `eliza.json`, unset an env var, install a package, or add a plugin checkout.

**Scope:** This is **diagnostics**, not hiding failures. Serious resolution errors still surface normally.

**Related code:** `eliza/packages/agent/src/runtime/plugin-collector.ts`, `eliza/packages/agent/src/runtime/plugin-resolver.ts`. See also [Plugin resolution and NODE_PATH](../plugin-resolution-and-node-path.md#optional-plugins-why-was-this-package-in-the-load-set).

## Browser / stagehand server path

**Problem:** `@elizaos/plugin-browser` expects a **stagehand-server** binary tree under `dist/server/` inside the npm package, but the published tarball does not ship it. Eliza links or discovers a checkout under `plugins/plugin-browser/stagehand-server/`.

**Why parent walk:** The runtime file lives at different depths (`eliza/packages/agent/...` vs `eliza/packages/agent/...` when using a submodule). A fixed `../` depth missed the workspace root. **`findPluginBrowserStagehandDir()`** walks parents until it finds `plugins/plugin-browser/stagehand-server` with `dist/index.js` or `src/index.ts`.

**Operational note:** If you do not use browser automation, absence of stagehand is **expected**; messages are intentionally concise at debug level so daily dev is not spammed.

**Related:** `scripts/link-browser-server.mjs`, `eliza/packages/agent/src/runtime/eliza.ts` (`ensureBrowserServerLink`, `findPluginBrowserStagehandDir`).

## Life-ops schema migrations (PGlite)

**Problem:** On **PGlite** / Postgres, `SAVEPOINT` only works inside a transaction; ad hoc `executeRawSql` calls default to autocommit. Nested migrations that used savepoints without an outer `BEGIN`/`COMMIT` failed or behaved inconsistently.

**Why explicit transactions:** `runMigrationWithSavepoint()` wraps each named migration in `BEGIN` → `SAVEPOINT` → … → `RELEASE`/`ROLLBACK TO` → `COMMIT` (or `ROLLBACK` on outer failure). That matches Postgres semantics and keeps SQLite behavior valid too.

**Indexes vs `ALTER TABLE`:** Indexes on `life_task_definitions` and related tables reference **ownership columns** (`domain`, `subject_type`, …). **Why indexes run after ALTERs:** legacy databases created before those columns existed would fail `CREATE INDEX` if indexes ran in the same batch as initial `CREATE TABLE` without the columns present. Core index statements are applied **after** ownership `ALTER TABLE` / backfill steps.

**Tests:** `eliza/packages/agent/test/lifeops-pglite-schema.test.ts` covers legacy upgrade paths.

## Workspace dependency scripts

**Problem:** Monorepos that mix **`workspace:*`**, published semver ranges, and local `./eliza` / `plugins/*` checkouts drift easily. Manual `package.json` edits are error-prone and hard to review.

**Why the scripts exist:**

| Script / npm command | Role |
|----------------------|------|
| `workspace:deps:sync` (`fix-workspace-deps.mjs`) | Rewrite in-repo dependency specifiers to `workspace:*` across every workspace `package.json`. **Writes to disk** — only use when you want to commit the specifier change. Prefer `workspace:prepare` for day-to-day install. |
| `workspace:deps:check` / `--check` | Verify without writing — CI or pre-commit. |
| `workspace:deps:restore` | `fix-workspace-deps.mjs --restore` — read each workspace `package.json` from a git ref (default `HEAD`) and restore any `workspace:*` specifier back to its original version string. Counterpart to `workspace:deps:sync`. |
| `workspace:replace-versions` / `workspace:restore-refs` | Targeted version-string operations aligned with eliza upstream tooling patterns. |
| `workspace:prepare` | **Preferred:** submodule init + snapshot current `package.json` files + rewrite to `workspace:*` + `bun install` + restore from snapshot. After this runs, the on-disk `package.json` files are byte-identical to before, but `bun install` saw `workspace:*` during resolution. Use `--leave-on-disk` for the legacy behaviour where `workspace:*` persists. |

**Discovery:** `scripts/lib/workspace-discovery.mjs` centralizes how we find workspace roots and plugin packages so scripts do not duplicate fragile path logic.

## Terminal dev banners (orchestrator, Vite, API, Electrobun)

**What:** On TTYs, startup can show a **Unicode-framed** settings table plus a **large figlet-style heading** per subsystem (orchestrator, Vite, API, Electrobun), with **cyan/magenta ANSI** when color is allowed (`NO_COLOR` / `FORCE_COLOR` respected).

**Why this is not “product UI”:** Output is **stdout for local development only** — same category as port tables and log prefixes. **Goal:** faster human/agent scanning of **effective env** (ports, feature flags, sources) when four processes start. It does not change dashboard, chat, or companion rendering.

**Where:** `eliza/packages/shared` (table + color + figlet helpers), `eliza/packages/app-core/scripts/dev-platform.mjs`, `apps/app/vite.config.ts`, `eliza/packages/app-core/src/runtime/dev-server.ts`, Electrobun banner helper under `apps/app/electrobun/src/`.

**Related doc:** [Desktop local development](../apps/desktop-local-development.md#startup-tables-and-terminal-banners).

## Gitignored local artifacts

**`cache/audio/`** — Local TTS or media caches can grow large; they are **not** part of the source tree.

**`scripts/bin/*` (except `.gitkeep`)** — Optional place to drop tools (e.g. `yt-dlp`) for `PATH` in Electrobun dev scripts. **Why not commit binaries:** size, platform variance, and license/update lifecycle belong on the developer machine, not in git.

---

See [Changelog](../changelog.mdx) for shipped dates and [Roadmap](../roadmap.md) for follow-ups.
