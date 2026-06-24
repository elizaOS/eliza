# #9141 — app-wide frontend performance audit

A systematic, read-only sweep across **seven dimensions** of the whole dashboard
(not just the shell): bootstrap/loading, re-render cascades, animations/reflows,
idle/battery loops, the 3D/agent layer, data-fetching/streaming, and view/list
rendering. High-confidence, low-risk findings were fixed in this PR; larger or
measurement-gated findings are listed as a prioritized backlog so nothing is
lost. Every item below is `file:line`-grounded.

## Fixed in this PR (high-confidence, verified)

| # | Dimension | File | Was | Now |
| --- | --- | --- | --- | --- |
| 1 | reflow | `sidebar-root.tsx:28,727` | drag animated `width`/`min-width` over 360ms (sidebar chases the pointer + layout/frame) and wrote width per-pointermove | drop width from the transition while resizable; rAF-coalesce width writes to ≤1/frame |
| 2 | reflow | `settings/VoiceConfigView.tsx:536,787` | mic meter wrote `style.width` + `transition-all` every audio frame (layout/frame while live) | compositor-only `transform: scaleX` + `transition-transform` |
| 3 | reflow | `shell/LoadingScreen.tsx:103` | boot progress bar animated `width` over 1.5s (paint/frame on first screen) | `transform: scaleX` from `origin-left` |
| 4 | re-render | `pages/ChatView.tsx:1445` | inbox `renderMessageContent` was an inline arrow → broke `ChatMessage` memo → every inbox message re-parsed markdown each render | module-level stable renderer |
| 5 | re-render | `state/useDataLoaders.ts:196` | `autonomousStoreRef.current` in a `useCallback` dep array → callback identity churned every autonomy merge → cascaded into `useStartupCoordinator` | removed (ref read is call-time/latest) |
| 6 | battery | `connectors/XRPairingPanel.tsx:47` | 5s poll with no visibility gate | `useIntervalWhenDocumentVisible` (interval cleared while hidden) |
| 7 | battery / reflow | `shell/ContinuousChatOverlay.tsx:1687` | `visualViewport.scroll` did `getComputedStyle` + double `setState` per event (fires constantly while the keyboard animates) | rAF-coalesce to ≤1 commit/frame, no-op-guard both setStates, `{ passive: true }` |
| 8 | battery | `state/startup-phase-hydrate.ts:340` | 5s PTY status poll with no visibility gate | skip the poll body while `document.hidden` (WS still hydrates on change) |

All eight: `ui` typecheck clean, biome clean, 84 targeted unit tests green, both
interaction-fps + reduced-motion e2e specs pass.

## What's already correct (verified — do NOT "optimize")

- **Token streaming is isolated.** rAF coalesces N tokens → ≤1 commit/frame; settled
  bubbles skip via `memo`+`arePropsEqual` (guarded by `chat-transcript.render-count.test`);
  `parseSegments` is per-bubble memoized. The shell does **not** re-render per token.
- `AppContext` keeps `conversationMessages` / `autonomousEvents` out of the value
  memo deps; high-frequency state is split into dedicated contexts.
- The chat transcript already windows (`selectVisibleShellMessages`, cap 80) and
  measures at ~93fps scroll / ~117fps sheet morph (see `README.md`).
- The `will-change` allow-list and the new `useApp()` gate are locked by tests.

## Prioritized backlog (deferred — each needs its own measurement / visual review)

**Battery (cloud-frontend polling cluster) — mechanical, but the cloud surface
## Backlog — now implemented in this PR

Everything the audit flagged that could be landed with verification has been
landed (the items below are no longer deferred):

**Battery (cloud-frontend poll cluster) — DONE.** All 6 un-gated 5–30s polls
(`app-analytics.tsx` ×3, `use-sandbox-status-poll.ts` ×2, `app-domains.tsx`,
`eliza-wallet-section.tsx`, `use-job-poller.ts`) now pause while the tab is
hidden (logic-only; no visual change).

**3D / agent layer (biggest GPU/battery win) — DONE + unit-tested.** The VRM
render loop now pauses when the canvas is offscreen (`IntersectionObserver`),
`ChatAvatar` passes `active={avatarVisible}` so the engine stops while collapsed,
and the dead `minimalBackgroundMode` flag is replaced with the real
`setHalfFramerateMode` throttle. The pause/throttle decision is a pure
`computeVrmPausePolicy` with 6 unit tests.

**Re-render / per-frame cost — DONE + tested.** `resource-cache.setCached` now
equality-gates (no re-render on an unchanged poll; 4 tests). `normalizeTranscriptMessage`
and `ChatView.visibleMsgs` are WeakMap-memoized per message identity (O(N)→O(1)
per token frame). Heavy list leaves (`PluginCard`, `FileCard`, `SkillRowButton`,
`ChatConversationItem`, `TranscriptBody` words, `LogRow`) are `React.memo`'d, and
`TrajectoryDetailView`'s event pipeline + `PluginsView`/`SkillsView` derivations
are moved out of the render body into `useMemo`.

## List "virtualization" — measured, and the right call is NOT to ship it

The row components are memoized (reconciliation cost bounded). For DOM-count
reduction I implemented the browser-native option — `content-visibility: auto`
(the existing `.cv-auto` utility in `base.css`) on the heavy list rows — and
**measured it** with a 3000-row scroll KPI spec rather than landing it blind:

```
plain-3000-rows     109fps · p95 16.7ms · worst 25.0ms · dropped 17/261
cv-auto-3000-rows    90fps · p95 17.7ms · worst 33.4ms · dropped 42/249
```

`content-visibility` made **scroll worse**, not better: it trades initial-mount
layout for *on-scroll* layout (rows lay out as they enter the viewport), adding
per-frame layout spikes (worst 25→33ms) — exactly the "objects moving / jank on
scroll" this work is meant to eliminate. So it was **reverted** — measurement
made the call. The same on-scroll-layout tradeoff applies to fixed-height JS
windowing, so true DOM-windowing is only worth it if a *specific* huge list's
**initial mount** (not its scroll) is measured as a real freeze, and then only
with a dynamic-height implementation + a scroll-recorded visual pass. The
memoizations are the net-positive win here; DOM windowing is not, by measurement.
