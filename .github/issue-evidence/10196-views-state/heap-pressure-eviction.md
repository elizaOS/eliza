# #10196 item 2 — live `usedJSHeapSize` fed into the view prune decision

One of #10196's three enumerated deliverables: *"Live `usedJSHeapSize` fed into
the prune decision in `DynamicViewLoader.tsx` + `retained-lazy.tsx` (today
eviction uses only the static `deviceMemory` hint + visibility); emit it on
`module-cache-telemetry`."* This lands exactly that.

## Before

Every bounded view cache (the remote-bundle module cache in
`DynamicViewLoader.tsx`, the route-chunk module cache via `retained-lazy.tsx`,
and the keep-alive view-instance cache) sized its cap+TTL **only** off the static
`navigator.deviceMemory` hint (`isLowMemoryDevice()` in
`state/bounded-view-lru.ts`). A roomy device (e.g. 16 GB reported) whose **live**
JS heap was climbing toward its limit kept the larger caps — eviction only
tightened when an OS `memorypressure` / visibility event happened to fire.
`performance.memory` / `usedJSHeapSize` was read **nowhere** (the exact gap
#10196 calls out).

## After

`state/bounded-view-lru.ts` gains a live-heap reader and a combined pressure
signal:

- `resolveHeapUsage()` reads Chromium's `performance.memory`
  (`usedJSHeapSize` / `jsHeapSizeLimit`), `null` on engines without it.
- `getHeapPressureRatio()` / `isHeapUnderPressure()` — pressured at
  `HEAP_PRESSURE_RATIO = 0.8` (heap within 20 % of its hard limit).
- `isUnderMemoryPressure()` = `isLowMemoryDevice() || isHeapUnderPressure()` — the
  caches now shrink under **either** a small device **or** a near-limit live heap.

All four tier helpers (`getRetainedModuleMaxEntries` / `…TtlMs`,
`getKeepAliveMaxViews` / `…TtlMs`) and `DynamicViewLoader`'s
`getBundleCacheMaxEntries` / `…TtlMs` now consult `isUnderMemoryPressure()`.
Engines without `performance.memory` (Safari/Firefox) fall back to the static
device hint exactly as before — **no behavior change** there.

And every `module-cache-telemetry` event now carries the live reading
(`usedJSHeapSize`, `jsHeapSizeLimit`, `heapPressureRatio`), so an `audit:views`
soak (#10196 item 1) can read whether eviction actually tracked heap growth, not
just the static tier. This is the telemetry plumbing item 1 will drain.

## Evidence

Tests: `packages/ui/src/state/bounded-view-lru.heap.test.ts` (new) +
`retained-lazy` / `view-lifecycle` / `DynamicViewLoader` regressions — all green
(see run output below). Screenshots are **N/A**: this is backend eviction
sizing + telemetry plumbing, not a rendered surface.

```
$ bun run --cwd packages/ui test -- \
    src/state/bounded-view-lru.heap.test.ts src/retained-lazy.test.tsx \
    src/state/view-lifecycle.test.tsx src/components/views/DynamicViewLoader.test.tsx

 ✓ src/state/bounded-view-lru.heap.test.ts  (8 tests)   — new: heap pressure + telemetry
 ✓ src/retained-lazy.test.tsx                            — module-cache tiers, unchanged
 ✓ src/state/view-lifecycle.test.tsx                     — keep-alive tiers, unchanged
 ✓ src/components/views/DynamicViewLoader.test.tsx       — bundle-cache eviction, unchanged

 Test Files  4 passed (4)
      Tests  45 passed (45)
```

The new file asserts: a near-limit live heap (`usedJSHeapSize/jsHeapSizeLimit ≥
0.8`) drops `getRetainedModuleMaxEntries` / `getKeepAliveMaxViews` / the bundle
caps to their low-memory tier on a **16 GB** device; engines without
`performance.memory` keep the device-hint behavior; and the heap reading
(`usedJSHeapSize` / `jsHeapSizeLimit` / `heapPressureRatio`) appears on the
emitted `module-cache-telemetry` event (and is absent when the hint is). The 3
existing tier suites are unchanged (jsdom has no `performance.memory`, so
`isUnderMemoryPressure()` ≡ `isLowMemoryDevice()` there).

## Still open on #10196 (need the real app server, not this slice)

- **Item 1** — the `audit:views` soak that enumerates `/api/views`, cycles every
  real system/developer/release/preview/plugin view N times, drains the render +
  module-cache (now heap-bearing) telemetry rings, and exits non-zero on
  regression. (Disqualifies the synthetic fixture; needs the live app.)
- **Item 3** — the committed per-real-view-kind scorecard + crash/eviction demos
  against real shipping bundles.
