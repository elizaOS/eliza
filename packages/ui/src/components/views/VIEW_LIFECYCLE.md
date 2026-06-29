# App-shell view lifecycle contract (#10202)

The app is an operating-system shell for loadable plugin/system/developer
**views**. This document is the **contract** for how a view is mounted, shown,
hidden, paused, evicted, restored, and recovered — and it is backed by
**code-level primitives**, not just prose. Every primitive named here is
exported from `@elizaos/ui`.

## Why

Before #10202 the shell had only two states: a view was either mounted (the
active tab) or unmounted (every other tab). There was no `hide`/`pause`/`evict`
vocabulary, no per-view crash isolation for builtin/system views (only remote
plugin views had a keyed boundary), no per-view render/memory/resource
telemetry, and three places (`retained-lazy.tsx`, `DynamicViewLoader.tsx`,
`GameViewOverlay.tsx`) each re-implemented their own
visibility/memory-pressure pause+evict listeners. This contract centralizes all
of that.

## The phases

`ViewLifecyclePhase` (`state/view-lifecycle-types.ts`) is a real state machine:

| phase        | meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `mounted`    | subtree created, not yet the active view                                |
| `active`     | the visible view — receives input, runs timers/RAF/media                |
| `inactive`   | retained (keep-alive) but hidden; pinned views also rest here           |
| `paused`     | hidden **and** app-backgrounded / tab-hidden / memory-pressure          |
| `evicted`    | unmounted + cleaned up (TTL / LRU / pressure, or hide for default views)|
| `crashed`    | a render threw and `ViewErrorBoundary` caught it                        |
| `recovering` | a crashed view is remounting after Retry                                |

Transitions (driven by `ViewLifecycleController`):

```
mount ─▶ active ──hide──▶ (keepAlive? paused/inactive : evicted)
                 ◀─show/resume──
paused ──app-resume / tab-visible──▶ active|inactive
inactive/paused ──TTL | LRU | memorypressure──▶ evicted
active ──render throw──▶ crashed ──Retry──▶ recovering ──▶ active
```

## State-retention policy

Resolved per view by `resolveViewLifecyclePolicy(viewId)` →
`ViewLifecyclePolicy { keepAlive, pausable, pinned }`:

- **Default** (`keepAlive:false, pausable:true, pinned:false`) — today's
  behavior: hide ≡ unmount ≡ `evict("inactive")`. Transient component state is
  dropped and recomputed on next mount; nothing is persisted to disk. **Zero
  blast radius** — the shell mounts exactly the active view.
- **Keep-alive** (`keepAlive:true`) — retained mounted-but-hidden and **paused**
  while hidden, governed by a device-memory **LRU** (`bounded-view-lru.ts`:
  default 3 retained, 1 on low-memory devices). Opt in per plugin page via the
  `keepAlive`/`pausable` fields on `AppShellPageRegistration`, or per builtin via
  the `BUILTIN_VIEW_POLICY` map, or at runtime via `registerViewPolicy(id, …)`.
- **Pinned** — `PINNED_VIEW_IDS = { "chat", "background" }`. **Never evicted.**
  These are **structural** surfaces that live outside the routed host
  (`ContinuousChatOverlay`/`HomeScreenMount` + `AppBackground` at the shell
  root) and are always mounted by `App()` directly. The controller refuses to
  evict their records (the explicit exemption), and `publish()` excludes them
  from the host render set (the routed host never paints a hidden slot for a
  structural surface) — they render through the host only when they are the
  active tab.

### Which host honors keep-alive

`KeepAliveViewHost` retains multiple views only when its `renderView(viewId)`
can reconstruct content for **any** retained id. The app's primary `ViewRouter`
is **active-only** (it computes one route's content per render and returns
`null` for non-active ids), so in the app the host mounts exactly the active
view — every view still gets a per-view boundary + telemetry + lifecycle slot +
signal-driven pause, but builtin/plugin views are **not** retained on hide
(default unmount-on-hide). The keep-alive + bounded-LRU + pinned mechanism is
fully exercised by the `__e2e__` fixture (a render-by-id host) and is available
to any future host that renders views by id. The host skips a slot whose
`renderView` returns `null`, so an active-only `renderView` never leaves an empty
slot behind.

## Pause / resume (timers, polling, media, native subscriptions)

A view reacts to its own lifecycle with one hook:

```tsx
import { useViewLifecycle, usePausableInterval, usePauseAware } from "@elizaos/ui";

useViewLifecycle({ onPause: () => stream.pause(), onResume: () => stream.play() });
usePausableInterval(poll, 5000);          // auto-stops while hidden/paused
const { paused } = usePauseAware();        // gate ad-hoc media/native work
```

`ViewLifecycleController.installSignals()` wires **one** set of
`APP_PAUSE`/`APP_RESUME`/`visibilitychange`/`memorypressure` listeners that
pause every pausable view and force-evict retained views under pressure.

## Crash containment

Every routed view is wrapped in `ViewErrorBoundary` (keyed `viewId:recoverKey`),
so one crashing view shows a local Retry / Back-to-launcher fallback while the
shell and sibling views keep running. On catch it fires
`controller.markCrashed(viewId)` + a `crash` telemetry sample + a structured
`[ViewLifecycle]` log. Retry resets the boundary, bumps the key (a genuine fresh
remount, not a latched stale crash), and calls an optional `onRecover` (remote
views pass `recoverView` to also invalidate the bundle cache).

## Telemetry

Per-view runtime telemetry (`view-runtime-telemetry.ts`,
`ViewTelemetryProfiler`) emits a `ViewRuntimeTelemetryEvent` on every
show/hide/pause/evict/crash carrying: render count + p95 commit duration (React
`<Profiler>`), JS heap (`performance.memory.usedJSHeapSize` when present), active
subscriptions / pending timers / heavy resources (`resource-counters.ts`). It
lands in a bounded `globalThis.__ELIZA_VIEW_RUNTIME_TELEMETRY__` ring + a
`eliza:view-runtime-telemetry` CustomEvent + a `[ViewTelemetry]` log line, so an
expensive/leaking view is visible in saved artifacts and logs — not just
devtools. A per-view rerender storm additionally trips the shared
`eliza:render-telemetry` channel tagged with the offending `viewId`.

## Eviction & memory budget

`KeepAliveViewHost` renders `controller.getRenderSet()` (active ∪ retained
keep-alive) and the controller enforces the LRU + TTL + pressure eviction. The
pure `view-memory-budget.ts` detector (`summarizeMemorySamples` +
`shouldReportMemoryGrowth`) turns a series of heap samples from a repeated
view-switch run into a leak verdict, mirroring `hooks/frame-budget.ts`.

## What the tests catch

| failure class                | test                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| rerender storm               | `KeepAliveViewHost.test.tsx` + the e2e storm view            |
| listener / timer leak        | `resource-counters.test.ts` + the e2e leaky view             |
| crash + recovery             | `ViewErrorBoundary.test.tsx` + the e2e crash                 |
| unbounded view-switch memory | `view-memory-budget.test.ts` + the e2e gc'd heap trend       |
| bounded eviction + exemptions| `view-lifecycle.test.tsx`                                     |
| full view-matrix coverage    | `view-lifecycle-matrix.test.ts` (every builtin tab)          |

The browser harness is `__e2e__/run-view-lifecycle-e2e.mjs`
(`bun run --cwd packages/ui test:view-lifecycle-e2e`): it drives the real
`KeepAliveViewHost` over a synthetic view matrix and proves all of the above in
headless Chromium, capturing screenshots + a walkthrough video + `telemetry.json`.
