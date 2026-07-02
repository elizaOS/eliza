# LEG W2 — spatial-view chrome + non-launcher gesture de-larp (#11343, #10722 items 5/6/8; #11144 lineage)

Branch `feat/ui-mobile-gap-burndown`. Evidence for the restored #11144 e2e
guard (#11343), the 44px rendered-geometry tap-target gate, and the new
real-gesture e2e over non-launcher surfaces.

## Status re-verification against origin/develop tip (72feba58394, 2026-07-02)

**#11144 is CLOSED on develop** — do not re-read this leg as the fix. History
(from the closing triage): #11230 inset attempt reverted by #11262; #11258
landed the real seam (`--shell-backnav-clearance` set by the shell wrappers,
consumed by `SpatialSurface` as `paddingTop`, `packages/ui/src/spatial/dom.tsx`)
plus the spec-side guard; unrelated cloud PR #11271 (stale branch) clobbered
BOTH; #11279 restored the source seam + added the unit guard
(`packages/ui/src/spatial/dom.backnav-clearance.test.tsx`) but NOT the spec.
The spec restoration was spun off as **#11343 — that is what this leg ships**,
reconciled to develop's landed mechanism (an earlier killed run here had
re-implemented the seam as a base.css `padding-inline-start` rule; that
divergent mechanism was dropped in favor of develop's `paddingTop` seam).

## What this leg ships

### 1. #11343 — restore the #11144 e2e occlusion guard (spec side)

- `packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts`:
  the two `KNOWN BUG (documented, not accepted)` workarounds are REMOVED. The
  inbox filter is driven through the real FIRST chip (`Email`, was `Discord`)
  and relationships through the dedicated `All` chip (was `Organizations`),
  each with a `document.elementFromPoint` center hit-test proving the chip —
  not the z-[60] back button — is topmost. Playwright refuses clicks on
  occluded targets, so the tap doubles as the occlusion assertion. Runs on the
  desktop `chromium` AND Pixel-7 `mobile-chromium` lanes.
- Because this worktree's base predates #11258/#11279, the develop seam is
  carried here byte-identically: `spatial/dom.tsx` `paddingTop` consumption +
  `spatial/dom.backnav-clearance.test.tsx` (develop's unit guard, verbatim —
  it parses the button's `top-[…+Xrem]`/`h-N` classes and the wrappers'
  clearance rem values, so it self-validates the geometry change below).
  At rebase these resolve as identical/superset content.

### 2. #10722 item 6 — 44px rendered-geometry tap-target gate

- Enforcement used to be a CSS token (`--min-touch-target`) + conventions;
  nothing measured what the browser laid out. Found while building the gate:
  `ShellBackButton` shipped 36×36 (`h-9 w-9`); spatial GUI buttons ~34px tall.
- `packages/app/test/ui-smoke/tap-target-geometry.spec.ts` (new): real
  `boundingBox()` floor (≥43.5px) on a Pixel-7 coarse-pointer viewport over
  the shell back button + every spatial-view button on `/inbox` and
  `/relationships`.
- Fixes that make it pass:
  - `App.tsx`: back button is a 44px (`h-11 w-11`) hit target with the 36px
    visual circle centered inside (resting look unchanged; circle stays at
    safe-area + 0.75rem). Wrapper clearance bumped `3rem → 3.25rem`
    (0.5rem top offset + 2.75rem hit target — the ported unit guard enforces
    exactly this arithmetic). This is a deliberate, small divergence from
    develop's 36px button, motivated by the Apple-HIG floor the gate enforces.
  - `styles/base.css`: `@media (pointer: coarse)` min-height/min-width floor
    for `[data-spatial-kind="button"]` (desktop mouse keeps the compact look).

### 3. #10722 items 5/8 — real-gesture e2e over zero-test non-launcher surfaces

- **RelationshipsGraphPanel pan** (`/apps/relationships`): had ZERO coverage
  (only pinch was tested). New spec test drives a genuine CDP one-finger drag:
  scrollLeft grows, pan does not zoom, reverse drag clamps at 0. Pinch test
  extended with the reverse (pinch-in) path. Source fix required for the
  mobile lane: `max-w-full` → `max-w-[min(100%,100vw)]` on the graph container
  (`max-w-full` is circular when the flex ancestor chain stretches to the
  zoomed svg — measured clientWidth === scrollWidth === 2640px on a 412px
  Pixel-7 viewport, i.e. page scrolled instead of graph panning; #11145
  lineage). The spec's #11145 width assertion was also re-pointed at
  `[data-spatial-surface]` — the decomposed `/relationships` route renders the
  spatial LIST view, not the zoomable graph panel it previously (vacuously)
  queried.
- **KioskViewCanvas / FloatingViewWindow drag** (`?shellMode=kiosk`): had ZERO
  tests anywhere. `kiosk-view-canvas-drag.spec.ts` (new): REAL staged-pointer
  title-bar drag through pointer capture; the native-host event SOURCE is
  seeded at its real injection seam (a minimal `window.__ELIZA_ELECTROBUN_RPC__`
  bridge emitting `kioskViewEvent` payloads — the component, hit-testing and
  drag are fully real). Covers empty state, mount, drag, release (no
  drag-after-up), unmount, newest-floating-wins, malformed-event rejection,
  same-windowId remount dedupe.
- **Resize handles with no web-reachable live mount** — conversations
  `Sidebar` handle (live mount = Electrobun DetachedShellRoot only),
  `TasksEventsPanel` widgets handle (orphaned by the continuous-chat
  redesign; still the shipped implementation), cloud `ResizablePanelGroup`:
  `packages/ui/src/components/composites/__e2e__/resize-handles.e2e.test.ts`
  (new, + fixture) — the isolated esbuild-fixture + headless-Chromium pattern,
  REAL staged pointer drags against the REAL shipped components: grow, clamp
  min/max, collapse thresholds, expand-restore, aria-value contract,
  localStorage persistence, zero leaked page/console errors. Auto-discovered
  by `vitest.e2e.config.ts` (`src/**/__e2e__/**/*.test.{ts,tsx}`) →
  `test:e2e` lane. Finding recorded in the drag helper: the drag gutters hang
  half outside their `overflow-hidden` panel (`-mr-1.5`/`-ml-1.5`), so the
  effective grab area is ~6px, not the authored 12px.
- **Item 8 dead-export re-verification — the gap description was stale:**
  `touchPinch` was already removed on develop (NOTE at the bottom of
  `packages/ui/src/testing/real-touch-gestures.ts` documents it) and
  `touchTap` is NOT dead (consumers: `run-chat-sheet-e2e.mjs`,
  `slash-commands.spec.ts`). The real residual was the PA spec's private
  pinch copy — extracted to
  `packages/app/test/ui-smoke/helpers/real-touch-gestures.ts` (new):
  per-gesture CDP touch emulation (`Emulation.setTouchEmulationEnabled` +
  `Input.dispatchTouchEvent`) for desktop-layout specs — `touchPinch` +
  `touchPan`, viewport-intersection guarded. The `packages/ui` helper keeps
  its hasTouch-context contract; its NOTE now points here.

### 4. #9310 items 1-2 — NOT taken (capacity)

Deliberately not half-landed; see recommendationsNotImplemented in the leg
report.

## Artifacts

- `spec-run-ui-smoke.txt` — full Playwright output: PA decomposed +
  kiosk-drag + tap-target specs on `chromium` + `mobile-chromium`.
- `spec-run-resize-handles-e2e.txt` — isolated `__e2e__` runner output (6
  tests) + `spec-run-unit-guard.txt` — `dom.backnav-clearance.test.tsx`.
- `screenshots/` — before (clearance zeroed at the real seam) / after of the
  previously-occluded first chips, desktop + Pixel-7, `/inbox` +
  `/relationships` (`capture-backnav-evidence.mjs`, driven against the live
  ui-smoke stack), plus resize-handle e2e frames copied from the runner
  output. The inbox pair shows the canonical bug surface: "before" has the
  back button sitting on the `Email` chip, "after" has the chip row below it.
  The relationships captures show the route's error state (the capture stack
  has no lifeops relationships backend; the seam displacing the first content
  row is still visible) — the populated `All`-chip proof is the spec's
  `elementFromPoint` hit-test on the mocked ui-smoke lanes.
- Real-LLM trajectory: N/A — no agent/action/provider/prompt/model behavior
  change (shell CSS seam, test infrastructure, gesture e2e only).
- Video walkthrough: N/A — every flow under test is captured as
  deterministic screenshot sequences by the specs themselves; the
  Playwright lanes run headless with retain-on-failure video.
