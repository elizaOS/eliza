# Chat window UX: scrolling, gestures, search, mic

## Summary

Workstream research for the LifeOps Personal Assistant MVP (GitHub project 15).
Chat is the MVP's primary surface: every LifeOps flow (reminders, goals, todos,
scheduling, coordination) is driven through the continuous chat overlay, so its
scrolling, gesture, search, and voice affordances must be solid for every kind
of user — children, adults with ADHD/ADD/Asperger's/autism, neurotypical
adults, and elderly people — with no therapy language and no special rails,
just a chat window that never fights the hand that drives it.

The audit's headline: **the gesture/detent system asked for in the brief is
already built, well-documented, and CI-gated** (pull-to-maximize landed in
#13531; the maximize button is already gone; detent magnetism, springs, and
haptics all exist). What is actually missing or broken is narrower: **no
history pagination at all** (hard 80-row render cap over a 200-message server
window), **a transcript that can silently become horizontally scrollable**,
**message search that exists end-to-end but is unreachable from the primary
surface**, **a mic button that does not pulse while recording** on the primary
surface, and **a stale Playwright suite still asserting buttons #13531
removed**. The MVP plan is fix-and-verify, not build: six issues, five of
which delete, wire, or repair what already exists.

## Current state

### Render paths (three, not two)

1. **`ContinuousChatOverlay`** — the primary surface, always mounted over every
   view ([packages/ui/src/App.tsx:2513](../../../ui/src/App.tsx),
   [packages/ui/src/components/shell/ContinuousChatOverlay.tsx:128-157](../../../ui/src/components/shell/ContinuousChatOverlay.tsx)).
   One infinite thread since #13531 — no conversation switcher, no clear/new-chat.
2. **`ChatSurface` + `AssistantOverlay` + `HomePill`** — mounted only by
   `ShellFoundationMount` for the desktop OS chat-overlay window and the kiosk
   shell ([App.tsx:496](../../../ui/src/App.tsx), [App.tsx:539](../../../ui/src/App.tsx)).
3. **`ChatView`** (1,536 lines) — desktop *detached* chat windows only, via
   [packages/app-core/src/runtime/desktop/AppWindowRenderer.tsx:44](../../../app-core/src/runtime/desktop/AppWindowRenderer.tsx)
   and `DetachedShellRoot.tsx:71`. Not routed anywhere in the web/mobile shell.

Message *text* additionally renders through two independent code paths (overlay
body renderer vs `MessageContent.tsx`), pinned by a render-parity contract test
(`parser-parity.contract.test.ts`, `render-parity.contract.tsx`). Any formatting
change must land in both.

### Sheet state machine, detents, gestures — built and tested

Single source of truth: `ChatMode = "pill" | "input" | "half" | "full"` with
derived `ChatState` (`CLOSED | INPUT | OPEN_UNDER_HALF | OPEN_HALF_OR_OVER |
MAXIMIZED`) — [ContinuousChatOverlay.tsx:177-193](../../../ui/src/components/shell/ContinuousChatOverlay.tsx).
The interaction constants ARE the spec (all verified in code):

| Parameter | Value | Ref (ContinuousChatOverlay.tsx) |
|---|---|---|
| HALF detent | 0.46 × viewport height | `:197` |
| FULL detent | ≈0.9 × viewport (inset, under status bar) | `:198-206` |
| Pull-to-maximize | peak raw pull ≥ max(0.8×vh, FULL) + 56px over-pull | `:207`, `:3228-3237` |
| Restore-from-maximized | downward pull starting in top 20% of panel | `:211`, `:3878-3892` |
| Detent magnet | release within 64px snaps to detent, else free-rest | `:219`, `:3385-3410` |
| Pill→input morph distance | 120px of finger travel; excess flows into thread height | `:265`, `:3158-3183` |
| Sheet spring | stiffness 320 / damping 34 / mass 0.9 | `:247-252` |
| Pill-open spring | stiffness 300 / damping 26 / mass 0.85 | `:256-261` |
| Detent haptic | Capacitor light impact per detent cross | `:228-246` |

The live drag writes the `flexBasis` MotionValue directly (no React re-render
per frame, `:3985-3995`); flicks step one detent; slow drags free-rest with
magnetism; pull-down through input→pill reverses the morph under the finger
(`:3171-3183`). **The maximize button is already removed** — header carries
only a Launcher button (`:3895-3901`), and
`ContinuousChatOverlay.test.tsx:2308-2309` pins `chat-full-maximize` /
`chat-full-clear` absent. Pull-to-maximize + top-20% restore are e2e-covered
with real CDP touch (`__e2e__/run-chat-sheet-e2e.mjs:256-354`).

Gesture engine: `use-pull-gesture.ts` — axis lock at 8px slop, widened
0.8-dominance cone for swipes, rAF-coalesced drag, commit-on-`pointercancel`
for Android (#9943), capture-loss handling for rotation. **Weakness:** its
`verticalScrollPriority` option (`:87-102`, built for the transcript,
#chat-scroll-web) has **zero consumers** — dead code since #13531 removed the
transcript swipe binding (grep: only definition sites match).

### Scrolling — what works and what is missing

Works: the transcript scroller (`#continuous-thread`,
[ContinuousChatOverlay.tsx:4025](../../../ui/src/components/shell/ContinuousChatOverlay.tsx))
is `touch-pan-y overflow-y-auto overscroll-contain` with the iOS
`-webkit-overflow-scrolling:touch` fix and a WebKit-safe bounded-height flex
chain (`:3966-3995`, guarded by `run-chat-scroll-web-e2e.mjs` on Chromium AND
WebKit). Tail-follow / jump-to-latest is the shared `useThreadAutoScroll`
engine ([packages/ui/src/hooks/useThreadAutoScroll.ts:1-23](../../../ui/src/hooks/useThreadAutoScroll.ts),
wired at `:4126`).

**Missing — history pagination (req 1).** `GET
/api/conversations/:id/messages` returns only the newest 200
(`CONVERSATION_MESSAGE_WINDOW`,
[packages/agent/src/api/conversation-routes.ts:1050](../../../agent/src/api/conversation-routes.ts),
`:1684-1688`); there is no `before` cursor — only `?around=<id>` for search
jumps (`:1052-1118`). The client fetches the window as a full replace
([packages/ui/src/state/useDataLoaders.ts:336-368](../../../ui/src/state/useDataLoaders.ts))
and the overlay renders at most the last **80** rows
(`MAX_RENDERED_SHELL_MESSAGES`,
[packages/ui/src/components/shell/shell-state.ts:60](../../../ui/src/components/shell/shell-state.ts)).
Scrolling up simply ends. `runtime.getMemories` already supports
`end`+`limit`+`orderBy desc` (used by the around-window), so a cursor is a
small, store-pushed addition.

**Broken — horizontal-scroll "unlock" (req 1).** Root cause found statically:
the scroller sets `overflow-y-auto` but **not** `overflow-x-hidden` (`:4025`).
Per CSS Overflow, specifying one axis coerces the other from `visible` to
`auto` — so the moment any child overflows horizontally, the transcript itself
becomes a horizontal scroll container. `touch-pan-y` blocks touch panning, but
**trackpad/wheel deltas ignore `touch-action`** — on desktop a diagonal
two-finger scroll pans the thread sideways. Overflowing children exist today:
text/code attachment previews use both-axes `overflow-auto` with no
`overscroll-x-contain` ([MessageAttachments.tsx:831](../../../ui/src/components/chat/MessageAttachments.tsx));
inline widgets are unaudited for min-width. The other chat path already does
this right: `chat-thread-layout.tsx:106-107` pairs `overflow-x-hidden
overflow-y-auto`. Designed horizontal scrollers inside the thread
(code blocks `MessageContent.tsx:572,1242`, chips bar `TopicChipsBar.tsx:30`)
are fine — they carry `overscroll-x-contain`.

### Search (req 2) — exists end-to-end, unreachable on the primary surface

- Server: `GET /api/conversations/messages/search` — SQL `ILIKE` pushdown
  scoped to accessible rooms, BM25 ranking, snippets, limit clamp 50
  ([conversation-routes.ts:1470-1545](../../../agent/src/api/conversation-routes.ts)).
- Client API: `searchConversationMessages()`
  ([packages/ui/src/api/client-chat.ts:334-337](../../../ui/src/api/client-chat.ts)).
- Jump plumbing: `?around=` window load
  (`useDataLoaders.ts:451-481`, #9955).
- UI: `MessageSearchPanel`
  ([packages/ui/src/components/chat/message-search/MessageSearchPanel.tsx:33](../../../ui/src/components/chat/message-search/MessageSearchPanel.tsx))
  — mounted **only** inside `ConversationsSidebar:971`, which is mounted
  **only** in the desktop detached shell (`DetachedShellRoot.tsx:157`). On
  web/mobile — the MVP surfaces — search is unreachable (an architecture
  rule-10 violation: an endpoint without a client trigger on the shipping
  surface).

### Mic + '+' buttons (req 5)

`SoftButton` ([ContinuousChatOverlay.tsx:309-370](../../../ui/src/components/shell/ContinuousChatOverlay.tsx)):
borderless 44×44 hit target (WCAG 2.5.5), lucide icons at 26px, hand-drawn
glyphs at 30px — the icons were already sized up when chrome was removed; the
26px-vs-30px mix is a minor optical inconsistency (plus glyph renders larger
than mic/send). Row inset `px-2 py-2 gap-1.5` (`:4233`).

Pulse matrix (verified):

| Surface | While mic hot | Ref |
|---|---|---|
| Grabber bar | ✅ `animate-pulse bg-accent` | `:509-513`, glow at `:3703` |
| Collapsed pill | ✅ same pulse (`glow={listening \|\| responding}`) | `:582-586`, `:4445` |
| **Overlay mic button** | ❌ static `text-accent` only | `:349-355`, `:4400-4427` |
| ChatSurface mic (kiosk path) | ✅ `active && "animate-pulse"` | glass-composer.tsx:108 |
| HomePill (foundation path) | ✅ `animate-pulse bg-warn/70` on listening | HomePill.tsx:66-68 |

So req 5's pill-pulses-when-collapsed is **done**; the mic button itself not
pulsing on the primary surface is the gap, and it is inconsistent with the
sibling path.

### Jank sources + perf gating

- The height animation is `flexBasis` — layout runs every frame by design (the
  pointer-driven MotionValue avoids re-renders but not reflow; `:3985-3995`).
  Rows are `React.memo`'d with a comparator (`chat-message.tsx:379,409`);
  token streaming is context-isolated (`useShellController.ts:317-325`). No
  `content-visibility`/containment anywhere (grep: zero hits) — every open
  sheet re-lays-out all ≤80 rows per animation frame.
- Hard perf gates exist and run in CI: `run-chat-perf-gate.mjs` (dropped-frame
  ratio, p95 frame time, CLS ≤ 0.1 on the REAL overlay) in
  `chat-shell-gestures.yml:160`; frame-glitch outlier detection
  (`run-chat-sheet-frame-glitch-e2e.mjs`) at `:169-175`.
- **Known red:** `run-perf-gate-e2e.mjs` has a pre-existing CLS failure — the
  fixture layout-shifts **0.80** during scroll+swipe, reproducing on develop
  ([chat-shell-gestures.yml:18-22](../../../../.github/workflows/chat-shell-gestures.yml))
  — yet `test.yml:333` still runs it as a hard-fail leg. Untriaged.

### Test infrastructure (req 6) — strong core, stale edges

Strong: 11 real-browser gesture runners (`packages/ui/src/components/shell/__e2e__/`),
a CHAT_GESTURE_COVERAGE gate that fails CI when a gesture-handler site lacks a
matrix row ([packages/app/test/chat-gesture-coverage.test.ts](../../../app/test/chat-gesture-coverage.test.ts),
docs in `packages/app/docs/CHAT_GESTURE_COVERAGE.md`), WebKit engine coverage
for the scroll chain, and a canary mode proving the glitch detectors fire.

Stale (post-#13531): `chat-clear-swipe.spec.ts:386,424,497` and
`chat-send-voice-newchat-fuzz.spec.ts:325,382` still drive the removed
`chat-full-clear` button; `walkthrough/journey.ts:1108-1121` still expects
`chat-full-maximize`; `chat-clear-swipe.spec.ts` is still in a CI lane
(`scenario-pr.yml:341`). The unit suite already pins those testids as ABSENT
(`ContinuousChatOverlay.test.tsx:2308-2309`) — the repo is testing both sides
of the same contradiction. Minor slop: literal `"   "` filler class strings in
`cn()` calls (`:497`, `:570`, HomePill.tsx:54).

## Design considerations

- **Chat is load-bearing for LifeOps.** A parent checking a child's reminder
  history, or an ADHD user scrolling back to "what did I agree to yesterday",
  hits the pagination wall immediately. History reachability (scroll-up +
  search) is MVP-critical, not polish.
- **Never fight the scroll.** The one thing that most degrades trust in a chat
  surface is an axis surprise. The fix must be at the scroller (one line +
  child audit), not per-widget whack-a-mole.
- **The gesture system is done — protect it, don't touch it.** The detent
  physics match the brief (lerp on drag, springs on release, half detent,
  pull-to-top maximize). New work must ride the existing perf gates so nothing
  slows the drag path.
- **Pagination must not regress the drag path.** Prepending hundreds of rows
  into a scroller whose height animates per-frame is the main risk; render
  windowing and scroll-anchor math must be part of the same change.
- **Doctrine:** no side panels, no suggestion chips, uniform top bar. Search
  therefore lives *inside the sheet* (header affordance at half+), not as a
  sidebar. Orange accent only; pulse animations use the existing
  `animate-pulse` + `motion-reduce:animate-none` pattern.

## Open questions → answers

**Q1. Pagination: cursor design and interaction with the 80-row render cap?**
A: Add `?before=<messageId>` to GET messages (pivot's `createdAt` pushed into
the store as `end` + `orderBy desc` + `limit 100` — identical mechanics to the
existing around-window, `conversation-routes.ts:1088-1098`). Client keeps a
`hasOlder` flag (last page full ⇒ true). Overlay: top sentinel
(IntersectionObserver inside `#continuous-thread`) triggers the fetch; prepend
with manual scroll-anchor compensation (record `scrollHeight` before, restore
`scrollTop + delta` after — `overflow-anchor` is not implemented in WebKit).
The render cap becomes a *sliding window* over loaded messages (grow by page,
bounded ~400) rather than a hard `slice(-80)`; verify with the existing
`chat-perf-gate` thresholds. Rationale: reuses every mechanism already in the
file; no virtualizer dependency.

**Q2. Where does search live under the no-side-panels doctrine, and what
scope?** A: A search icon in the sheet header's intentionally-empty left slot
(`:3933-3935`), visible at half+ like the launcher button, opening an in-sheet
search row that reuses `MessageSearchPanel` (it is already
presentation-only/injectable). Scope: keep the endpoint's cross-conversation
reach; a hit in the active thread jumps via the existing around-window +
scroll-into-view; a hit in another conversation switches the active
conversation through the existing `handleSelectConversation` handoff — search
becomes the one sanctioned way to reach an older thread now that the switcher
is gone. Undecidable-without-owner: whether cross-thread jump violates the
one-infinite-thread doctrine. **Default: ship active-thread jump first; gate
cross-thread jump behind the same PR only if the owner confirms.**

**Q3. Should the maximize button come back?** A: No. #13531's pull-to-maximize
is implemented, unit-pinned, and e2e-covered. The remaining work is deleting
the stale specs that still look for the button (Q6/issue 5).

**Q4. Which states pulse the mic button?** A: Pulse exactly when the grabber/
pill glow (`listening || responding` drives those); for the button itself,
pulse on `recording || handsFree || transcriptionMode` — the same predicate
that sets `active` today (`:4420`) — so color and motion never disagree.
Respect `motion-reduce:animate-none` (pattern at `:512`).

**Q5. Hide or design horizontal scrolling for wide content?** A: Both, split
by ownership: the transcript gets `overflow-x-hidden` (parity with
`chat-thread-layout.tsx:106`); wide content scrolls *inside its own row*
(`overflow-x-auto overscroll-x-contain`, the `MessageContent.tsx:572` pattern)
— per repo doctrine "wide content must scroll inside its own container".
`MessageAttachments.tsx:831` additionally needs `overscroll-x-contain`.

**Q6. Bring ChatSurface/kiosk and detached-window paths to parity?** A: Not
for MVP. They are desktop/kiosk-only surfaces; the MVP surfaces are web +
mobile where `ContinuousChatOverlay` is the only path. Keep the render-parity
contract green; take no feature work there.

**Q7. Virtualize long threads?** A: No virtualizer for MVP. Measured-first:
add per-row `content-visibility: auto` + `contain-intrinsic-size` only if the
`chat-perf-gate` numbers regress after pagination lands (issue 6 pairs the
CLS triage with this). A virtualizer would fight the `mt-auto` bottom-anchored
layout and the detent height animation for little MVP gain.

## Recommendation (minimal-scope MVP plan, ordered)

1. **P0 — Lock the transcript to vertical scrolling** (1-line scroller fix +
   child audit + wheel/deltaX regression e2e). Smallest change, biggest feel
   improvement.
2. **P0 — Infinite scroll up with `before`-cursor pagination** (server cursor,
   client prepend + anchor, sliding render window, perf-gate verification).
3. **P1 — Wire message search into the overlay** (header affordance reusing
   `MessageSearchPanel` + around-window jump; active-thread scope first).
4. **P1 — Mic pulse + composer icon optics** (pulse on the primary surface,
   normalize 26/30px optical sizing, keep 44×44 targets; pill pulse already
   done — add the regression test).
5. **P1 — Reconcile stale gesture specs with #13531** (delete/rewrite
   `chat-full-clear`/`chat-full-maximize` consumers; delete the dead
   `verticalScrollPriority` option and filler class strings).
6. **P2 — Triage the perf-gate CLS 0.80 failure** and, only if pagination
   regresses frame budgets, add row containment.

Everything else in the brief (detents, springs, pull-to-maximize, pill morph,
haptics, pill pulse, gesture CI) is already implemented and gated — the job is
to not break it, which the existing `chat-shell-gestures.yml` lane enforces.

## Out of scope (explicit non-goals for MVP)

- Feature work on `ChatSurface`/kiosk/detached-window paths (parity contract
  only). No consolidation of the three render paths.
- Thread virtualization; framer-motion replacement; transform-based sheet
  animation rework.
- Cross-conversation UI beyond search-jump (no switcher/swipe resurrection).
- Semantic/vector message search (keyword ILIKE + BM25 is enough).
- New gesture surfaces (e.g. pull-from-transcript detent control — the grabber
  stays the single drag authority; note: any future scroller-attached pull
  gesture must use touch events + non-passive `preventDefault`, since
  `touch-action: pan-y` compositor scrolling `pointercancel`s pointer-based
  gestures).
- Suggestion strips (`SHOW_PROMPT_SUGGESTIONS` stays off, `:223`).

## Proposed issues

1. `[chat-ux]` Lock the chat transcript to vertical-only scrolling (P0)
2. `[chat-ux]` Infinite scroll up: async history pagination in the continuous chat overlay (P0)
3. `[chat-ux]` Wire message search into the primary chat surface (P1)
4. `[chat-ux]` Mic button pulses while recording; normalize composer icon optics (P1)
5. `[chat-ux]` Remove stale gesture specs and dead gesture options left behind by the one-infinite-thread change (P1)
6. `[chat-ux]` Triage the perf-gate CLS failure and guard long-thread scroll performance (P2)
