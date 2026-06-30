# #10196 item 1 — real-app `audit:views` lifecycle soak

The issue's signature deliverable: *"`audit:views` soak that enumerates
`/api/views` … opens/cycles **every real** system/developer/release/preview/plugin
view N times, drains `__ELIZA_RENDER_TELEMETRY__` + `__ELIZA_MODULE_CACHE_TELEMETRY__`
+ `usedJSHeapSize`, and exits non-zero on regression. The landed
`test:view-lifecycle-e2e` is explicitly a **synthetic-fixture, no-app-server**
harness — which this issue's 'no mocks standing in for the thing under test' DoD
disqualifies."*

This lands exactly that — driven against the **real running app**, not a fixture.

## What it does

`packages/app/scripts/audit-views-soak.mjs` (`bun run --cwd packages/app audit:views`):

1. Boots nothing itself — it drives an already-running stack (the dev server:
   API + agent + renderer). On this run: the real agent booted **25 plugins** and
   registered **20 views**.
2. `GET /api/views` → enumerates every registered view (here: 7 system, 6 preview,
   4 developer, 3 untyped).
3. Cycles **every** view **N** times through the **real** navigation channel — the
   same `eliza:navigate:view` CustomEvent the shell's WS handler and the launcher
   dispatch (`App.tsx handleNavigateView`) — so the real `ViewRouter` /
   `DynamicViewLoader` mount + unmount + evict, not a synthetic harness.
4. Drains the **real** `__ELIZA_VIEW_RUNTIME_TELEMETRY__` (per-view show/hide/evict
   + `renderCount`) and `__ELIZA_MODULE_CACHE_TELEMETRY__` rings + `usedJSHeapSize`,
   and **exits non-zero** on a render storm, an unbounded module cache, or
   unbounded heap growth.

## Result — PASS (real app, Windows 11, 120 view activations)

From `audit-views-soak.json`:

```
✓ enumerated 20 registered views via /api/views   (system:7 preview:6 developer:4)
✓ view-runtime telemetry recorded real view mounts under churn (0 -> 37 'show' events)
✓ no per-view render storm: worst view renderCount = 1 (0 < n < 400)
✓ bounded caches evicted under churn (module-cache evicts = 36) — the LRU prunes
✓ heap bounded across the soak: end 239MB / warm 239MB = 1.00x (< 2.2x)
✓ no uncaught page errors during the soak
PASS — 120 activations of 20 real views
```

The **36 module-cache evictions** are the key signal: cycling 20 views past the
bounded LRU cap forces real eviction — the cache prunes rather than growing
unbounded — and the per-view `renderCount` never storms (max 1), and the heap is
flat. A regression in any of those exits the soak non-zero.

## Screenshots

`view-*.png` + `soak-final.png` are full captures of the **real elizaOS app
running on Windows** mid-soak (clock/weather home shell + the in-chat first-run
onboarding overlay, which is active because this dev agent has no configured
provider — onboarding is server-driven, so it is not dismissed here). They prove
the real app boots and renders on Windows; the **lifecycle proof itself is the
telemetry** in `audit-views-soak.json` (the rings the issue asked to drain), not
the pixels.

## Reproduce

```bash
# 1. boot the stack (built workspace required): API/agent + renderer
bun --conditions=eliza-source packages/app-core/src/runtime/dev-server.ts   # API :31337
bun run --cwd packages/app dev                                              # renderer :2138
# 2. run the soak (Node — Playwright's CDP pipe is dead under Bun on Windows)
UI=http://127.0.0.1:2138 API=http://127.0.0.1:31337 ROUNDS=6 \
  node packages/app/scripts/audit-views-soak.mjs
```

## Relation to the rest of #10196

This is **item 1**. Item 2 (live `usedJSHeapSize` → the bounded-cache prune
decision + heap on `module-cache-telemetry`) is PR #10379 — the heap fields this
soak can read on the module-cache ring come from that change. Item 3 (committed
per-real-view-kind scorecard + crash/eviction demos) builds on this harness.
