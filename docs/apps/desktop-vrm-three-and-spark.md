---
title: "Desktop VRM, Three.js, and Spark (WHYs)"
sidebarTitle: "VRM / Three / Spark"
description: "Why the Electrobun desktop build can load two copies of three.js, how that breaks Gaussian splats and VRM, and what Eliza does in Vite and app-core to keep one Three instance and resilient avatar loading."
---

# Desktop VRM, Three.js, and Spark

This page is for **contributors and reviewers**. It explains **why** the 3D companion could fail only on **Electrobun** (or other nested-dependency layouts), **why** a naive “disable cloud when `enabled: false`” guard broke **first-time cloud login**, and **where** the fixes live.

## Problem: two copies of `three`

### Symptom

- Console: **`THREE.WARNING: Multiple instances of Three.js being imported.`**
- Shader error: **`Can not resolve #include <splatDefines>`** (from `@sparkjsdev/spark` + Gaussian splats).
- **VRM** or **world background** fails to initialize even though assets and WebGL/WebGPU are fine.

### Root cause

**`THREE.ShaderChunk`** is a **singleton on the `three` module instance** you imported. **`@sparkjsdev/spark`** registers `ShaderChunk.splatDefines` on **its** `three` import. If another part of the bundle imported a **different** `three` package instance (different physical file / different pre-bundle), splat shaders compile on instance **A** while Spark registered chunks on instance **B** → missing `#include`.

**Why Electrobun was prone to this:** the desktop shell can pull **`three`** from **its own** `node_modules` (e.g. an older semver) while the Eliza app resolves **`three`** from the **repo root**. Vite’s dependency optimizer can then pre-bundle **examples/jsm** loaders against one graph and Spark against another unless we **force a single resolution path** and **pre-bundle JSM entrypoints together** with `three` core.

### What we do (and why)

| Layer | What | Why |
|--------|------|-----|
| **`apps/app/vite.config.ts`** — `sparkPatchPlugin` **`resolveId`** | Bare `import "three"` from outside `node_modules/three` is re-resolved to the **workspace root** `three` package. | Stops nested copies (e.g. under Electrobun) from winning. **`resolve.alias` with absolute paths** was tried but **broke Rollup production builds**; a **`resolveId` hook** keeps dev and prod consistent. |
| Same plugin — **`transform`** on `spark.module.js` | Hoist `THREE.ShaderChunk.splatDefines = …` to **module load** instead of only inside lazy `getShaders()`. | Splats can compile **before** `SparkRenderer` runs; lazy registration is too late. |
| **`optimizeDeps.include`** | List **`three`** plus the **`three/examples/jsm/...`** imports the avatar stack uses (DRACO, GLTF, OrbitControls, etc.). | Ensures esbuild pre-bundles **one** shared `three` identity for those chunks. |
| **`resolve.dedupe`** | Includes **`three`** (and Spark, app-core). | Extra nudge so the bundler prefers one instance. |

## Problem: wrong asset URLs at module load time

### Symptom

- **404** for `default.vrm.gz` or wrong **DRACO** base URL in **packaged / desktop** builds.

### Root cause

**Module-level constants** that call `resolveAppAssetUrl` or read boot config run when the JS module **first evaluates**. In some bundles, **boot config or `import.meta.url` context** is not final yet → **cached wrong paths** for the whole session.

### What we do (and why)

- **`VrmViewer`**: **`getDefaultVrmPath()`** is a **function**, not a module-level constant, so the default VRM path resolves when the viewer needs it.
- **`VrmEngine`**: **`getDracoDecoderPath()`** lazily caches the DRACO decoder base URL.
- **`vrm.ts`**: **`BUNDLED_VRM_FALLBACK_SLUG = "eliza-1"`** when the roster is empty — **why:** shipped assets use **`eliza-1`…`eliza-8`**; there is **no** `default.*` on disk, so falling back to `"default"` guaranteed 404s.

## Problem: splat world took down the avatar

### Symptom

A bad or unsupported **Gaussian splat** world prevents the **VRM** from appearing.

### Root cause

World load and VRM load shared one failure path; Spark init or `SplatMesh` errors aborted the whole companion pipeline.

### What we do (and why)

- **`VrmEngine`**: **`ensureSparkRenderer`** wraps Spark init in **try/catch**, sets **`sparkRendererFailed`**, logs a warning — **world** degrades, **VRM** can continue.
- **`setWorldUrl`**: If Spark failed, **skip** world setup instead of throwing.
- **`VrmViewer`**: **`setWorldUrl`** is invoked inside **try/catch** so world errors **do not** block **`loadVrmFromUrl`**.

**Why this is in scope:** it restores **agent-visible** companion behavior (avatar + lip-sync) when optional **background** content fails — capability, not cosmetics.

## Related: Eliza Cloud login persistence (API)

### Symptom

Logs showed successful **`login_create_session` / `login_poll_status`**, then **`Skipping login persist: cloud is explicitly disabled`** — API key never saved.

### Root cause

A guard treated **`cloud.enabled === false`** as “user disconnected; ignore stale poll.” That is **also** the normal state for **never-connected** cloud, so **first login** was incorrectly discarded.

### What we do (and why)

- **`eliza/packages/app-core/src/api/cloud-routes.ts`**: A module-level **`cloudDisconnectEpoch`** increments on **`POST /api/cloud/disconnect`**. The login **poll** snapshots the epoch **before** `fetch`; **`persistCloudLoginStatus`** compares snapshot to current epoch. If they differ, a disconnect happened **during** the poll → skip persist. Otherwise **persist**, even when cloud started as disabled.

**Why not drop the guard entirely:** we still need to avoid **re-enabling** cloud from a **stale** authenticated response after the user explicitly disconnected mid-flight.

## How to verify

1. **Desktop / Electrobun:** Run **`bun run dev:desktop:watch`** (or production build), open companion/chat with VRM + optional splat world. Confirm **no** `Multiple instances of Three.js` and **no** `splatDefines` shader error in the webview console.
2. **Cloud:** With **`cloud.enabled: false`** in config, complete **Eliza Cloud** login from the UI; confirm **`cloud.enabled`** becomes **true** and the key is saved (and no spurious “explicitly disabled” skip log).
3. **Automated:** **`bun run check`**; tests under **`apps/app/test/app/vite-config.test.ts`**, **`eliza/packages/app-core/test/avatar/`** as applicable.

## Code map

| Area | Files |
|------|--------|
| Vite Three / Spark | `apps/app/vite.config.ts` (`sparkPatchPlugin`, `optimizeDeps`, `resolve.dedupe`) |
| VRM URLs / roster | `eliza/packages/app-core/src/state/vrm.ts` |
| Viewer load order / isolation | `eliza/packages/app-core/src/components/avatar/VrmViewer.tsx` |
| Spark + world + DRACO | `eliza/packages/app-core/src/components/avatar/VrmEngine.ts` |
| Cloud login persist | `eliza/packages/app-core/src/api/cloud-routes.ts` |
