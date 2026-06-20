# Frontend Performance Optimization Report

Date: 2026-06-19

Goal: make the app feel buttery smooth while reducing non-model CPU, GPU,
network, memory, and battery cost. LLM and on-device model execution are out of
scope for this pass.

## Executive summary

The main non-model performance risks were not one single slow component. They
were a set of lifecycle problems:

- heavy UI modules were imported for metadata or registration before users
  opened the corresponding view;
- dynamic view bundles stayed strongly retained until refresh, even after the
  user left a view;
- route prefetching imported every lazy route after startup, trading perceived
  navigation speed for immediate CPU/network pressure;
- polling and presence timers kept running even when hidden or inactive;
- 3D/vector/VRM code had cleanup paths that could leave render work alive;
- render telemetry captured stacks on every render before checking whether
  telemetry was enabled.

This pass implemented the safe high-leverage fixes: metadata-first page
registration, lazy heavy page wrappers, a bounded dynamic-view bundle LRU with
memory-pressure cleanup, hidden-page polling pause, bounded route prefetch,
reduced overlay presence traffic, lazy Three.js vector-browser runtime loading,
VRM loop cleanup hardening, and a shared retained lazy-module cache for
app-shell pages and overlay apps.

## Research pass 1: surface audit

### App shell and React rendering

Findings:

- `App.tsx` held the route shell, overlay routing, app-shell registry lookup,
  remote view loading, route prefetching, overlay presence reporting, desktop
  tabs, slash navigation, and startup gates in one large component. This made
  avoiding incidental re-renders important.
- The app-shell registry was read via `listAppShellPages()` inside memoized
  hooks, but the registry had no subscription. Late plugin registrations
  depended on unrelated app-state updates to repaint.
- `routeViewLoaders` recorded every lazy route and the startup idle effect
  imported all of them after the coordinator reached ready.
- Overlay presence posted every 25 seconds even when no overlay app was active.
- `useAvailableViews()` already used a shared cache and de-duped duplicate
  mounts, but its background poller did not pause while the document was hidden.

Implemented:

- Added app-shell page registry subscriptions via `useSyncExternalStore`.
- Added `loader` support to `AppShellPageRegistration`; heavy pages can now
  register metadata without evaluating their full React tree.
- App-shell page loaders now mount through `RetainedLazyComponent`, so the
  resolved page module is leased while active and can be cleaned up after it is
  inactive rather than being permanently retained by `React.lazy`.
- Replaced all-route warmup with a bounded, device-aware idle prefetcher:
  max four chunks, skipped when hidden, save-data is enabled, effective network
  is 2G/slow-2G, or `navigator.deviceMemory <= 4`.
- Changed overlay presence reporting to send inactive state once and only keep
  the 25s interval alive while an overlay is active.
- Made shared resource polling skip ticks while hidden and refresh once when the
  page becomes visible.

### Dynamic remote views

Findings:

- `DynamicViewLoader` cached imported bundle promises indefinitely by URL/export.
  Fast revisit was good, but inactive bundles and their cleanup hooks were never
  aged out.
- Standard capabilities and view interaction handlers were correctly
  unregistered on view replacement/unmount, but module-level cleanup was tied to
  unmount rather than memory/idle lifecycle.
- A pending import could resolve after a view had unmounted; if memory pressure
  evicted it before resolution, cleanup could be missed.

Implemented:

- Replaced the promise-only cache with a ref-counted LRU entry model:
  `promise`, resolved module, `refCount`, `lastUsedAt`, cleanup flag, and
  retention timer.
- Active leases are protected from eviction.
- Inactive bundles are retained briefly for smooth tab/view switching, then
  pruned by TTL/LRU.
- Low-memory devices use a smaller cache and shorter TTL.
- Memory pressure forces eviction; hidden-page visibility changes trigger idle
  pruning.
- Bundle cleanup hooks run safely and never crash the shell.
- Pending import eviction is handled: if an evicted import resolves later, its
  cleanup runs exactly once.

### Boot and heavy libraries

Findings:

- `packages/app/src/main.tsx` imported the companion package root during boot,
  which pulled in more VRM/Three/vector-browser surface than needed for first
  paint.
- The vector browser relied on companion-provided Three/WebGPU runtime in boot
  config, forcing heavy 3D dependencies into startup.
- Wallet app registration imported `InventoryView.tsx`, a large full-dashboard
  page, just to register `/inventory`.
- Task coordinator page registration imported the orchestrator workbench and
  TUI page eagerly.

Implemented:

- Split companion boot imports into exact lightweight submodules:
  companion app registration, scene status context, and inference notice logic.
- Made companion visual components lazy by exact subpath.
- Removed companion vector-browser runtime from boot config.
- Made vector browser load `three` and `three/webgpu` dynamically only when the
  3D graph mounts.
- Pointed the app wallet alias at the wallet register module and changed wallet
  page registration to a lazy loader.
- Changed task coordinator app-shell registrations to lazy loaders.
- Converted task coordinator slot registration to lazy Suspense-wrapped slot
  components, so the slots can register at boot without loading the full task
  UI until rendered.

### Telemetry and render diagnostics

Findings:

- `useRenderGuard` captured `Error().stack` during render before checking the
  render telemetry enable flag. That is expensive even when telemetry is off.
- The route label included query string data.

Implemented:

- Moved stack capture behind `isRenderTelemetryEnabled()`.
- Reduced route label to `window.location.pathname`.

### 3D / animation / simulation lifecycle

Findings:

- `VrmEngine.dispose()` stopped requestAnimationFrame late in teardown and used
  `cancelAnimationFrame` directly, which does not stop renderer
  `setAnimationLoop` paths.
- Vector browser initialized Three runtime through app boot config rather than
  through the mounted view.
- Overlay loader wrappers used a `WeakMap` of `React.lazy` components. That
  kept wrappers stable, but resolved modules were owned by React indefinitely.

Implemented:

- `VrmEngine.dispose()` now sets `loadingAborted` and calls `stopLoop()` before
  disposing scene/renderer resources.
- Vector browser runtime is lazily resolved in the view component and falls
  back from WebGPU to WebGL only when needed.
- Overlay loader wrappers now render through the same retained lazy-module
  cache as app-shell pages. Loader modules may export optional `cleanup()`,
  which runs when the inactive module is evicted under memory pressure, TTL, or
  LRU pruning.
- Both retained lazy modules and dynamic view bundles now also prune inactive
  entries on the shared app pause event. This is a stronger mobile/battery
  behavior than waiting for TTL when the shell is backgrounded.

## Research pass 2: lifecycle architecture

The second pass focused on the user's expanded target: metadata and lightweight
wrappers should load first; full view objects should load on demand; inactive
objects should be retained only while useful and evicted under pressure/idle.

Recommended architecture:

- Registries should hold durable metadata only: route IDs, paths, labels,
  icons, categories, bundle URLs, and lazy loaders.
- Loaded implementation objects should be behind a retained-module cache with
  acquire/release semantics.
- Active leases must not be evicted.
- Idle modules should be evicted by LRU overflow, TTL, memory pressure,
  hidden-page transition, and app pause events.
- Browser ESM cannot truly unload evaluated code, so eviction means dropping
  host references, unregistering handlers, and calling exported cleanup hooks.
- `React.lazy` is acceptable for route/page splitting but retains resolved
  modules forever. A future shared retained-boundary component should replace
  `React.lazy` for overlays and app-shell page loaders when true cache eviction
  is required there too.

Implemented:

- Dynamic remote view bundles now follow this retained-module model.
- App-shell page metadata can now register a `loader`.
- Wallet and task coordinator have been migrated to metadata-first page
  registration.
- App-shell page loaders and overlay loaders now use a shared retained-module
  lifecycle (`packages/ui/src/retained-lazy.tsx`) with active leases, TTL/LRU
  retention, low-memory policy, hidden-page pruning, memory-pressure eviction,
  and pending-import cleanup.

## Research pass 3: observability and pause behavior

The third pass focused on proving the cache lifecycle is visible and tunable
rather than merely implemented.

Implemented:

- Added `packages/ui/src/cache-telemetry.ts` and exported it from the UI root
  and browser barrels.
- Emitted `eliza:module-cache-telemetry` browser events for dynamic-view and
  retained-lazy module loads, load errors, releases, evictions, and cleanup.
- Included source, action, reason, optional cache key, active count, idle count,
  total cache size, timestamp, and path-only route in each telemetry sample.
- Added an opt-in global buffer:
  `globalThis.__ELIZA_MODULE_CACHE_TELEMETRY__ = []` lets profiling harnesses
  collect cache events without monkey-patching internals.
- Added app-pause lifecycle pruning to the retained lazy cache and dynamic view
  cache, with active entries protected and inactive entries force-evicted.
- Covered app-pause eviction and telemetry emission in both retained-module and
  dynamic-view tests.

## Research pass 4: sub-agent UI crawl

Sub-agents crawled the remaining UI, plugin/app registration, and test
instrumentation surfaces after the cache/lazy-loader work landed.

Implemented safe findings:

- `ChatTranscript` no longer passes freshly-created `children` into every
  `ChatMessage` row. It now passes a stable content renderer prop, so
  unchanged historical rows can stay memoized while a later message streams.
- `ChatView` memoizes chat row labels, copy callback, and message-content
  renderer instead of recreating them on every parent render.
- `ChatMessage` no longer writes edit-draft state on every non-editing text
  update, avoiding an extra render on streamed token updates.
- Chat row hover detection now uses one shared media-query subscription instead
  of one `matchMedia` listener per rendered row.
- Training, account, and connector-account polling now use
  `useIntervalWhenDocumentVisible`, preserving the initial fetch while pausing
  repeated refreshes in hidden tabs.
- `AgentElementOverlay` scroll/resize remeasurement is rAF-throttled and its
  scroll listener is passive while highlight mode is active.
- The main app root is wrapped in `RenderTelemetryProfiler id="AppRoot"`,
  gated by the existing render-telemetry enablement path, so whole-shell commit
  storms are observable without profiler overhead in normal sessions.
- Remaining static app-shell page registrations in Phone Companion, Facewear,
  and Model Tester now register metadata-first lazy loaders. Facewear keeps
  lightweight deferred compatibility exports for fallback hosts that import
  named view components directly.
- The wallet side-effect registration now imports the explicit register subpath
  instead of the package root/inventory barrel.
- Bulk side-effect app-module imports now run through a two-at-a-time idle
  scheduler instead of one immediate `Promise.all` burst.

Deferred findings:

- Splitting streaming chat state out of `AppContext` needs a public context API
  migration and broad consumer audit.
- Transcript virtualization/windowing needs product decisions around search,
  reply anchors, accessibility, and scroll restoration.
- Route-prefetch and app-shell lazy non-evaluation deserve dedicated smoke
  tests, but the current implementation paths are covered by focused unit tests
  and app registration smoke tests.

## Validation added

- `packages/ui/src/app-shell-registry.test.ts`
  - metadata-only lazy registrations are stored;
  - registry subscribers are notified;
  - unsubscribe stops notifications.
- `packages/ui/src/hooks/useAvailableViews.test.tsx`
  - hidden documents pause background polling;
  - visibility restore triggers one refresh.
- `packages/ui/src/components/views/DynamicViewLoader.test.tsx`
  - inactive bundles are retained after unmount;
  - memory pressure evicts and cleans them;
  - pending imports evicted before resolution still run cleanup after resolve;
  - app pause evicts inactive bundles and emits module-cache telemetry.
- `packages/ui/src/retained-lazy.test.tsx`
  - inactive app/overlay modules are retained briefly;
  - active modules are protected from pressure eviction;
  - pending loader resolution after eviction runs cleanup exactly once;
  - app pause evicts inactive modules and emits module-cache telemetry.
- `packages/ui/src/components/apps/AppWindowRenderer.helpers.test.tsx`
  - overlay wrappers stay stable;
  - inactive overlay loader modules clean up after pressure.
- `packages/ui/src/components/composites/chat/chat-transcript.memoization.test.tsx`
  - unchanged historical chat rows do not re-render their content while a later
    message streams new text.

Validation run:

- `bun run --cwd packages/ui test -- app-shell-registry.test.ts useAvailableViews.test.tsx components/views/DynamicViewLoader.test.tsx`
  passed: 3 files, 29 tests.
- `bun run --cwd packages/ui test -- retained-lazy.test.tsx components/apps/AppWindowRenderer.helpers.test.tsx app-shell-registry.test.ts components/views/DynamicViewLoader.test.tsx`
  passed: 4 files, 21 tests.
- `bun run --cwd packages/ui test -- retained-lazy.test.tsx components/apps/AppWindowRenderer.helpers.test.tsx App.navigate-view-wiring.test.tsx components/views/DynamicViewLoader.test.tsx`
  passed: 4 files, 25 tests.
- `bun run --cwd packages/ui test -- retained-lazy.test.tsx components/views/DynamicViewLoader.test.tsx components/apps/AppWindowRenderer.helpers.test.tsx`
  passed: 3 files, 22 tests after app-pause and telemetry coverage.
- `bun run --cwd packages/ui test -- retained-lazy.test.tsx components/views/DynamicViewLoader.test.tsx components/apps/AppWindowRenderer.helpers.test.tsx App.navigate-view-wiring.test.tsx`
  passed: 4 files, 27 tests after exporting module-cache telemetry.
- `bun run --cwd packages/ui test -- retained-lazy.test.tsx components/views/DynamicViewLoader.test.tsx components/apps/AppWindowRenderer.helpers.test.tsx App.navigate-view-wiring.test.tsx app-shell-registry.test.ts`
  passed: 5 files, 28 tests after broadening app-shell loader props.
- `bun run --cwd packages/ui test -- components/composites/chat/chat-transcript.memoization.test.tsx components/composites/chat/chat-message.voice-speaker.test.tsx components/views/DynamicViewLoader.test.tsx retained-lazy.test.tsx components/apps/AppWindowRenderer.helpers.test.tsx App.navigate-view-wiring.test.tsx app-shell-registry.test.ts`
  passed: 7 files, 33 tests after the chat memoization, polling, and overlay
  throttling pass.
- `bun run --cwd packages/ui typecheck`
  passed after adding the retained lazy-module cache and overlay/app-shell
  retained wrappers.
- `bun run --cwd packages/ui typecheck`
  passed again after app-pause pruning and telemetry exports.
- `bun run --cwd packages/ui typecheck`
  passed after the Facewear loader type adjustment.
- `bun run --cwd packages/app test -- plugin-registrations.test.ts`
  passed: 1 file, 3 tests.
- `bun run --cwd packages/app test -- plugin-registrations.test.ts`
  passed again after the explicit wallet register import and side-effect loader
  scheduler changes.
- `bun run --cwd plugins/plugin-facewear typecheck`
  passed after converting Facewear app-shell registrations to loaders.
- `bun run --cwd plugins/app-model-tester test -- model-tester-app.test.ts`
  passed after converting Model Tester shell pages to loaders.
- `bun run --cwd plugins/plugin-phone test -- PhoneCompanionApp.test.tsx`
  passed after converting Phone Companion shell registration to a loader.
- `bun run --cwd plugins/plugin-task-coordinator test`
  passed: 15 files, 177 tests.
- `bunx tsc --noEmit -p plugins/plugin-task-coordinator/tsconfig.build.json`
  passed.
- `bun run --cwd plugins/plugin-wallet-ui test`
  passed: 7 files, 36 tests.
- `bunx tsc --noEmit -p plugins/plugin-wallet-ui/tsconfig.build.json`
  passed.
- `bun run --cwd plugins/plugin-companion test`
  passed: 9 files, 44 tests.
- `bun run --cwd plugins/plugin-companion typecheck`
  passed.
- `bunx tsc --noEmit -p plugins/plugin-task-coordinator/tsconfig.build.json`
  passed after the retained slot wrapper change.
- `bunx tsc --noEmit -p plugins/plugin-wallet-ui/tsconfig.build.json`
  passed after the retained app-shell loader declaration change.

Validation limitation from the previous round:

- `bun run --cwd packages/app typecheck` currently fails on an unrelated broad
  `CSSProperties` declaration issue across many existing UI/cloud files
  (`position`, `fontFamily`, `backgroundColor`, etc. reported as unknown CSS
  properties). The focused tests and package typechecks above cover the touched
  performance paths.
- A later `bun run --cwd packages/ui typecheck` run is currently blocked by
  unrelated existing errors in `../core/src/features/basic-capabilities/index.ts`
  (`describeImageCached`) and
  `packages/ui/src/components/pages/WorkflowEditor.tsx`
  (`handleActivateRun`, `Play`). Focused UI tests for the changed paths pass.

## Remaining optimization backlog

Higher confidence:

- Add an automated smoke test that opens every app-shell loader route and
  asserts no boot-time import happened before activation.
- Add bundle-size CI checks around app main chunk and route chunks.
- Feed `eliza:module-cache-telemetry` into the existing render telemetry
  collector or a lightweight dev overlay so cache churn is visible during route
  audits.

Medium confidence:

- Split `AppContext` into selector-based stores for hot fields such as
  agent status, pty sessions, overlay state, and chat activity.
- Virtualize or window very long chat transcripts and high-cardinality tables.
- Replace broad `useApp()` consumers inside message rows with narrow selectors.
- Add hover/focus prefetch for view catalog cards and pinned/recent views using
  the retained cache.
- Gate animated backgrounds and decorative effects on reduced-motion,
  visibility, and low-power policy.

Needs careful product/design review:

- Reduce smooth-scroll frequency during streaming chat.
- Convert more first-party settings/cloud sections to lazy setting-section
  loaders.
- Apply the metadata-first pattern to all app plugins that still register pages
  with static `Component` imports.

## Practical performance impact

Expected wins:

- faster first paint and less startup main-thread contention;
- lower post-startup network/CPU burst from route prefetch;
- fewer hidden-tab wakeups and background network calls;
- less retained memory after leaving dynamic plugin views;
- lower chance of leaked 3D render loops after companion teardown;
- less render-time telemetry overhead in normal operation.

The changes are intentionally conservative: active views keep their leases,
metadata remains stable, and inactive view remount behavior matches the old
unmount/remount semantics while adding cleanup and pressure response.
