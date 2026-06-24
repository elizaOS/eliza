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
has its own visual-review gate:**
- 6 un-gated 5–30s polls in `cloud/applications/components/app-analytics.tsx:264,274,282`,
  `cloud/instances/lib/use-sandbox-status-poll.ts:132,249`, `app-domains.tsx:180`,
  `eliza-wallet-section.tsx:187`, `use-job-poller.ts:184` → add `useDocumentVisibility`.

**3D / agent layer (biggest GPU/battery win, needs runtime canvas verification):**
- VRM render loop never pauses when the canvas is offscreen — only on a hidden
  tab; no `IntersectionObserver` (`plugin-companion/.../VrmViewer.tsx:214`).
- `ChatAvatar` never passes `active`, so its WebGL engine renders continuously
  while the sidebar is collapsed (`ChatAvatar.tsx:125`).
- `minimalBackgroundMode` is a write-only dead flag — "animate when hidden" runs
  the full loop (`VrmEngine.ts:676,1498`).

**Re-render / per-frame cost (measurement-first):**
- `resource-cache.setCached` writes a fresh reference every poll tick with no
  equality gate → `useAvailableViews` re-renders the router + tab bar every 30s
  (`hooks/resource-cache.ts:130`).
- Per-message-identity memoization (WeakMap) for `normalizeTranscriptMessage` /
  `ChatView.visibleMsgs` so per-token cost stops scaling with thread length
  (`chat-transcript.tsx:128`, `ChatView.tsx:383`).

**List virtualization (no virtualization primitive exists in `packages/ui`):**
- `TranscriptBody` re-renders the full word tree per audio frame (`TranscriptBody.tsx:39`);
  `TrajectoryDetailView` builds its pipeline in the render body + unwindowed call
  list (`:400,705`); `LogsView` unwindowed (`:330`); `PluginCard`/`FileCard`/
  `SkillRowButton`/`ChatConversationItem` unmemoized heavy leaves. A single
  virtualization primitive + `React.memo` pass resolves most of these.

The deferred items are tracked as task chips / a follow-up so they get the
per-change profiling and (for cloud/3D) visual verification they require rather
than landing blind in this PR.
