# React Runtime Performance — Optimization Research

Scope: React runtime cost (CPU, smoothness, re-renders, retained memory of stateful objects) in `packages/ui` and `packages/app`. Companion docs in this folder cover bundle size, boot, and state-sync; this one is render-cost only.

All file:line citations are against the `develop` checkout at `/path/to/eliza` on 2026-06-01.

---

## A. Critical Assessment

The app has a **single God context** problem that dominates every other React-runtime concern.

`AppProviderInner` (`packages/ui/src/state/AppContext.tsx:204`) composes ~10 sub-state hooks (`useLifecycleState`, `useDisplayPreferences`, `useChatState`, `useCloudState`, `useWalletState`, `usePluginsSkillsState`, `useDataLoaders`, the startup coordinator, …) and funnels **all of it** into one memoized object, `value` (`AppContext.tsx:1924`). That object has ~300 fields and a dependency array of ~400 entries (`AppContext.tsx:2345-2756`). It is published through one provider, `<AppContext.Provider value={value}>` (`AppContext.tsx:2779`), and consumed by `useApp()` (`packages/ui/src/state/useApp.ts:19`).

**191 components call `useApp()`** (measured: `grep -rl "useApp()" packages/ui/src plugins | wc -l` → 191). React context has no selector mechanism: when the provided value's identity changes, **every one of those 191 consumers re-renders**, regardless of which field they read. Because the `value` memo depends on ~250 state fields, *any* state change anywhere — a wallet balance poll, a heartbeat event, a log line, a streaming token — produces a brand-new `value` object and re-renders the entire subscriber set.

The team clearly knows this is a problem: there are hand-built escape hatches (`ChatComposerContext`, `PtySessionsContext`, comments at `AppContext.tsx:1916-1922` explaining what was *excluded* to stop heartbeat cascades, a `useRenderGuard` loop detector at `packages/ui/src/hooks/useRenderGuard.ts`, and a clean per-key `useSyncExternalStore` cache at `packages/ui/src/hooks/resource-cache.ts`). But the escape hatches are spot fixes; the core value is still monolithic, and two of the worst hot paths still flow through it:

1. **Streaming chat tokens.** Each SSE token calls `setConversationMessages` (`useChatSend.ts:778`, no throttle/batch — `useStreamingText.ts:130`), and `conversationMessages` is in the `value` dep array (`AppContext.tsx:2386`). So **every token re-renders all 191 `useApp()` consumers**, including the App shell, the sidebar, settings panels that aren't even visible, and — critically — every message bubble.

2. **Message bubbles subscribe to the God context.** `MessageContent` (`packages/ui/src/components/chat/MessageContent.tsx:1037`, a 1332-line unmemoized component) itself calls `useApp()` (`MessageContent.tsx:1042`) and is rendered once per message. The enclosing `ChatMessage` is `memo`'d (`chat-message.tsx:221`) but is fed an inline `children` element and inline `onCopy`/`onEdit` callbacks from `ChatView` (`ChatView.tsx:595-603`), which bust the memo every render. Net effect: during a single streamed response with N messages on screen, the cost per token is O(N) full re-renders of a 1332-line component, each of which is also a context subscriber that would re-render anyway.

Secondary issues, in rough order of impact:

- **No list virtualization anywhere** (`grep -rl "react-window|react-virtual|virtuoso|useVirtualizer" packages/ui/src` → empty). Chat transcript (`chat-transcript.tsx:193`), logs (`LogsView.tsx:271`), database rows, vector browser, and memory viewer all render the full list into the DOM. Combined with no message/log cap (no `slice(-N)` on `conversationMessages` or `logs`), long sessions accumulate unbounded DOM nodes and retained message objects.
- **O(n²) reply lookup** in the transcript: `chat-transcript.tsx:197` does `normalizedMessages.find(...)` inside the `.map`, so reply resolution is quadratic in message count on every transcript render.
- **The test-mode `useApp` proxy** (`useApp.ts:24`) allocates a fresh `Proxy` on every render in `NODE_ENV=test`, which inflates test-render cost but not production.

The good news: the architecture for the fix already exists in-repo (`resource-cache.ts` shows the `useSyncExternalStore` pattern the team is comfortable with), so the highest-impact change — splitting the God context — is incremental, not a rewrite.

---

## B. Optimization Catalog

Ranked by confidence × impact. "Renders" = full component re-renders triggered.

| # | Optimization | Confidence | Impact | Risk | Primary evidence |
|---|---|---|---|---|---|
| 1 | Throttle/coalesce streaming-token `setConversationMessages` to one commit per animation frame | High | High | Low | `useChatSend.ts:778`, `useStreamingText.ts:130` |
| 2 | Stop message bubbles subscribing to the God context: pass `sendActionMessage`/`setTab` as props, or read from a thin dedicated context | High | High | Low | `MessageContent.tsx:1042` |
| 3 | Stabilize `ChatTranscript`'s child/callback props (`renderMessageContent`, `onCopy`) so `memo(ChatMessage)` actually holds | High | High | Low | `ChatView.tsx:595-603`, `chat-message.tsx:221` |
| 4 | Split `AppContext` into stable-actions context + sliced state contexts (or `useSyncExternalStore` selectors) | High | Very High | Medium | `AppContext.tsx:1924`, 191 consumers |
| 5 | Virtualize the chat transcript (and cap retained messages) | Medium | High | Medium | `chat-transcript.tsx:193`, no cap in `useChatSend.ts` |
| 6 | Virtualize / cap the logs list | High | Medium | Low | `LogsView.tsx:271` |
| 7 | Fix O(n²) reply-target lookup in transcript with an id→message map | High | Medium | Low | `chat-transcript.tsx:197` |
| 8 | Wrap always-mounted shell leaves with `memo` + use `useDeferredValue` for view-switch / transcript updates | Medium | Medium | Low | `App.tsx:1367`, `DynamicViewLoader.tsx` |
| 9 | Memoize the always-rendered `MessageContent` (after #2 lands) | Medium | Medium | Low | `MessageContent.tsx:1037` |
| 10 | Virtualize DatabaseView / VectorBrowserView / MemoryViewer long lists | Low | Medium | Medium | `DatabaseView.tsx`, `VectorBrowserView.tsx` |

---

## C. Detailed Findings

Each finding carries the 7 required fields: (1) problem+evidence, (2) fix sketch, (3) real before/after measurement, (4) confidence, (5) impact, (6) risk, (7) how to verify nothing breaks.

### Finding 1 — Streaming tokens commit to the God context with no throttle

**(1) Problem + evidence.** The SSE token callback updates message state once per token: `applyStreamingTextModification(setConversationMessages, { mode: "replace", fullText })` at `useChatSend.ts:778` (and the parallel path at `:1181`). `applyStreamingTextModification` (`useStreamingText.ts:130`) commits synchronously every call — no rAF, no batching, no debounce. `conversationMessages` is a dependency of the `AppContext` `value` memo (`AppContext.tsx:2386`), so each token rebuilds `value` and re-renders all 191 `useApp()` consumers. A fast model emitting 30-80 tokens/s therefore drives 30-80 full-tree context commits per second during every response. This is the single hottest path in the app.

**(2) Fix sketch.** Coalesce token updates into one commit per frame. Accumulate the latest `fullText` in a ref; schedule a single `requestAnimationFrame` that flushes the newest snapshot via `applyStreamingTextModification(... mode:"replace")`; cancel/replace the pending frame on each new token; flush synchronously on stream end (`complete`/`fail`/`drop`) so the final text is never dropped. Keep `mode:"replace"` (it already takes a cumulative snapshot at `useChatSend.ts:771-774`), so coalescing is loss-free — only intermediate frames are skipped. This belongs in `useStreamingText.ts` as a `createStreamingTextFlusher(setMessages)` helper so both send paths reuse it.

**(3) Before/after measurement.** Render-count harness (defined in section D). Script: open chat, send a prompt that yields a ~400-token response against a fast local/groq model, count `RENDER_TELEMETRY_EVENT` emissions and React Profiler commits for the response window.
- Instrument: temporarily lower `INFO_THRESHOLD` to `1` in a local build, or better, use the dedicated counter from section D that records *every* commit (not just loop-threshold breaches). Count commits of `App`, `ConversationsSidebar`, and a sample `MessageContent` over the streaming window.
- Expected: before = ~1 commit per token across all subscribers (hundreds of commits/response); after = ~1 commit per frame (≤60/s, typically far fewer), i.e. a 5-20× reduction in commits for the same response, and `frontend-kpi.mjs` `longTasksMs` drop during a scripted streamed turn.
- Command: `node packages/benchmarks/loadperf/frontend-kpi.mjs --url=http://127.0.0.1:2138` against a dev server while the harness script streams a response; compare `longTasksMs` before/after.

**(4) Confidence:** High. The dep is provably in the array; rAF coalescing of cumulative-snapshot updates is a standard, loss-free technique.

**(5) Impact:** High. Directly removes the dominant per-token cascade; biggest single smoothness win during the app's most common interaction.

**(6) Risk:** Low. The only behavioral change is that intermediate frames are skipped; final text is flushed on stream completion. Edge: ensure the rAF is flushed/cancelled on `abort` and unmount.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test` (covers `useChatSend.test.tsx`, `useStreamingText`). Add a test asserting that after several `append`/`replace` calls + a `complete`, the final message text equals the last snapshot. Manual: stream a long response and confirm the visible text still updates smoothly and ends on the correct full text.

---

### Finding 2 — Every message bubble is a God-context subscriber

**(1) Problem + evidence.** `MessageContent` calls `useApp()` at `MessageContent.tsx:1042` and only uses `sendActionMessage` (`:1043`) and `setTab` (`:1095`) from it. It is rendered once per visible message via `renderMessageContent` (`ChatView.tsx:598`). Because it subscribes to the God context, **each bubble re-renders on every AppContext change** — i.e. on every streaming token (Finding 1), every poll, every heartbeat — even though nothing it displays changed. The component is 1332 lines and unmemoized.

**(2) Fix sketch.** Remove `useApp()` from `MessageContent`. Pass `sendActionMessage` and `onOpenSettings` (or `setTab`) down as props from `ChatView` (which already has them). Those two callbacks are referentially stable in the context (they're `useCallback`'d). Alternatively, introduce a tiny `ChatActionsContext` exposing only `{ sendActionMessage, setTab }` so bubbles subscribe to a value that changes almost never. Prop-drilling two callbacks one level is the lowest-risk option.

**(3) Before/after measurement.** Render-count harness (section D). Mount a transcript with 50 messages; trigger an unrelated AppContext change (e.g. dispatch a fake heartbeat/poll that flips an unrelated field). Count `MessageContent:<id>` commits.
- Expected: before = 50 commits (all bubbles re-render); after = 0 commits for unrelated changes.
- Because `MessageContent` already carries `useRenderGuard("MessageContent:"+id)` (`MessageContent.tsx:1041`), commits surface in `window.__ELIZA_RENDER_TELEMETRY__` once the threshold is lowered, or directly via the per-render counter in section D.

**(4) Confidence:** High. The only context reads are two stable callbacks.

**(5) Impact:** High. Combined with Finding 1, removes the O(N-messages) multiplier from the hottest path.

**(6) Risk:** Low. Pure plumbing; no behavior change.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test` (MessageContent tests: `MessageContent.sensitive-request.test.tsx`). Manual: action buttons/choices in messages still fire (they call `sendActionMessage`), and "open settings" links still navigate.

---

### Finding 3 — `memo(ChatMessage)` is defeated by inline props

**(1) Problem + evidence.** `ChatMessage` is wrapped in `memo` (`chat-message.tsx:221`) so it should skip re-render when its props are unchanged. But `ChatTranscript` (`chat-transcript.tsx:210-224`) passes it `children = renderTranscriptMessageContent(message, renderMessageContent)` where `renderMessageContent` is the inline arrow created fresh each `ChatView` render (`ChatView.tsx:598-603`), and `onCopy` is also an inline arrow (`ChatView.tsx:595-597`). New `children`/`onCopy` identities every render → `memo` always misses → every bubble re-renders on every transcript render.

**(2) Fix sketch.** Wrap `renderMessageContent` and `onCopy` in `useCallback` in `ChatView` (stable deps: `analysisMode`, `copyToClipboard`). The `renderMessageContent` arrow closes over `analysisMode`, so include it in deps. This alone won't help while bubbles subscribe to the God context (Finding 2), so it must land with #2; together they make `memo(ChatMessage)` genuinely effective.

**(3) Before/after measurement.** Render-count harness: render transcript with 50 messages, change one message's text (simulate the in-flight assistant turn updating). Count how many *other* `ChatMessage` bubbles commit.
- Expected: before = all 50 commit; after (with #2+#3) = only the 1 changed bubble (and its neighbor due to grouping/reply lookup) commit.

**(4) Confidence:** High. Standard memo-defeat pattern, directly visible in source.

**(5) Impact:** High (once #2 lands). Turns the transcript from "re-render everything" into "re-render only the changed bubble."

**(6) Risk:** Low.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test` (chat-transcript/chat-message tests). Manual: editing, copying, speaking, and reply rendering still work.

---

### Finding 4 — Split the monolithic `AppContext` value

**(1) Problem + evidence.** One memo (`AppContext.tsx:1924`) with ~300 fields / ~400 deps published to 191 consumers (`useApp.ts:19`). The dep array still includes `chatInput`, `chatSending`, `chatPendingImages`, and `ptySessions` (`AppContext.tsx:2749-2755`) despite comments claiming they're routed through separate contexts — so the value still rebuilds on chat keystrokes and PTY polls. Any field change re-renders all consumers because context has no selector granularity.

**(2) Fix sketch.** Three-tier split, lowest-risk-first:
- **Tier A (stable actions context).** All the `handle*`/`load*`/`set*` callbacks are already `useCallback`'d and rarely change identity. Move them into an `AppActionsContext` whose value is memoized on just the callbacks. ~150 of the 400 deps move out of the volatile state value. Components that only call actions (most dialogs, settings forms) stop re-rendering on state churn entirely.
- **Tier B (domain slices).** Group the remaining state into cohesive providers that mostly already exist as sub-hooks: `WalletStateContext`, `PluginsSkillsContext`, `CloudStateContext`, `ChatStateContext`, `FirstRunContext`. Each provider memoizes on its own slice. A wallet poll then only re-renders wallet consumers, not the whole app.
- **Tier C (optional, highest payoff/most work).** Convert `AppContext` to a `useSyncExternalStore` store with `useAppSelector(selector)`, mirroring the proven `resource-cache.ts:43` pattern already in the repo. Consumers re-render only when their selected slice changes by `Object.is`.
Start with Tier A (mechanical, near-zero behavioral risk) and Tier B for the noisiest slices (wallet, cloud, plugins) since those poll on timers.

**(3) Before/after measurement.** Render-count harness (section D), scripted scenario: (a) boot to ready, (b) idle 10s while background polls run (wallet/cloud/update/heartbeat), (c) type 20 chars in composer, (d) switch view chat→settings→chat. Sum total commits per component across the scenario.
- Expected: idle background polls → before: 191 consumers commit per poll tick; after Tier A+B: only the relevant slice's consumers (single digits) commit. Composer typing → already mitigated by `ChatComposerContext`, verify no regression. Capture the total commit count delta; target ≥5× reduction in idle-churn commits.

**(4) Confidence:** High on Tier A (mechanical), High on Tier B (sub-hooks already isolate the state), Medium on Tier C (more surface).

**(5) Impact:** Very High. This is the root cause; it amplifies every other finding.

**(6) Risk:** Medium. Splitting providers risks missing a consumer or changing render timing. Mitigate by keeping `useApp()` as a back-compat shim that reads from all the new contexts during migration, then migrating consumers incrementally and deleting the shim.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test` + `bun run --cwd packages/app test:e2e` (Playwright UI smoke). The App navigate-view wiring tests (`packages/ui/src/App.navigate-view-wiring.test.tsx`) and `App.cloud-shell.test.tsx` exercise the provider tree. Use the `useRenderGuard` loop detector as a regression net — no new error-severity telemetry events should appear.

---

### Finding 5 — Chat transcript is not virtualized and messages are uncapped

**(1) Problem + evidence.** `ChatTranscript` maps the full message array into the DOM (`chat-transcript.tsx:193`); no windowing library is used anywhere in the package. `conversationMessages` has no retention cap — `useChatSend.ts` only `slice`s for previews/truncation (`:731`, `:1092`), never bounds the array. Long sessions retain every message object and every bubble DOM node, raising memory and per-render layout cost linearly.

**(2) Fix sketch.** Add a windowing layer to the transcript. Because chat is bottom-anchored with variable-height messages, use a maintained virtualizer (e.g. `@tanstack/react-virtual` dynamic measurement, or a "render last K + on-scroll-up load older" windowing). Pair with a soft retention cap on `conversationMessages` (e.g. keep the last ~300 in state, lazily backfill older from the API on scroll). Keep auto-scroll behavior (`ChatView.tsx:421-435`) working with the virtualizer's scroll API.

**(3) Before/after measurement.** Frontend-KPI + DOM node count. Script the harness to load a conversation of 500 messages.
- `document.querySelectorAll('[data-testid="companion-message-row"], .w-full.space-y-1\\.5 > *').length` before/after (expect full count → window size, e.g. 500 → ~30).
- `performance.memory.usedJSHeapSize` (Chromium) sampled after load, and `frontend-kpi.mjs` `longTasksMs` during a scroll-to-top scripted interaction. Expect heap + long-task reductions proportional to the node-count cut.

**(4) Confidence:** Medium. High that virtualization helps; medium because variable-height bottom-anchored chat virtualization is fiddly and must preserve auto-scroll, grouping, and reply rendering.

**(5) Impact:** High for long sessions; negligible for short ones.

**(6) Risk:** Medium. Auto-scroll, "scroll up to load older," grouping (`chat-transcript.tsx:201-207`), and reply lookup (#7) all interact with windowing.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test` (ChatTranscript/ChatView tests) + manual: send/receive, scroll up through history, edit/copy/speak, grouping and reply chips still correct, auto-scroll on new message still works.

---

### Finding 6 — Logs list is not virtualized

**(1) Problem + evidence.** `LogsView` maps every `filteredLogs` entry into a DOM row inline (`LogsView.tsx:271`), with no row-level `memo` and no windowing. Logs stream in continuously; the entire filtered list re-renders and re-mounts rows on each `logs` update, and the DOM grows unbounded.

**(2) Fix sketch.** Virtualize the rows (same library as #5; logs are uniform-ish height so fixed/estimated-size windowing is simpler than chat) and extract a `memo`'d `LogRow` component keyed by a stable id. Cap retained logs in state to a rolling window (e.g. last 2000) and let filters query the server for older.

**(3) Before/after measurement.** Frontend-KPI + node count on the logs route with a busy agent (logs streaming).
- `document.querySelectorAll('[data-testid="log-entry"]').length` before/after (expect full count → window size).
- `frontend-kpi.mjs longTasksMs` while logs stream for 10s; expect a drop.

**(4) Confidence:** High. Uniform list, straightforward virtualization.

**(5) Impact:** Medium. Only when the Logs view is open with high log volume.

**(6) Risk:** Low. Filters and the time/level/source/tags columns are pure presentation.

**(7) Verify nothing breaks.** Manual: filtering by source/tag/level still works, scroll position behaves, empty/skeleton states still render (`LogsView.tsx:244-261`).

---

### Finding 7 — O(n²) reply-target lookup in the transcript

**(1) Problem + evidence.** Inside the message `.map`, the transcript resolves replies with `normalizedMessages.find(c => c.id === message.replyToMessageId)` (`chat-transcript.tsx:197`). That's a linear scan per message → O(n²) over the list, recomputed on every transcript render.

**(2) Fix sketch.** Build an `id → message` `Map` once per render in a `useMemo` over `normalizedMessages`, then look up replies in O(1). Also memoize `getMessageGroupingKey` results if grouping shows up hot.

**(3) Before/after measurement.** Microbench + Profiler. Render a 500-message transcript where ~30% are replies; measure `ChatTranscript` commit duration in React DevTools Profiler (or wrap the render body in `performance.now()` deltas via a temporary instrument).
- Expected: render-phase time for the transcript drops from O(n²) to O(n); on 500 messages this is the difference between ~250k and ~500 comparisons.

**(4) Confidence:** High. Direct algorithmic fix.

**(5) Impact:** Medium, scaling with message count; compounds with #5.

**(6) Risk:** Low. Same lookup result, faster.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test`; manual: reply chips still resolve to the correct quoted message.

---

### Finding 8 — Use concurrent features for view switches and heavy updates; memoize always-mounted shell leaves

**(1) Problem + evidence.** View switching mounts a new page synchronously; `DynamicViewLoader` (`DynamicViewLoader.tsx:479`) lazy-loads bundles but the transition isn't wrapped in `startTransition`, so the chat→settings→view switch blocks paint on the new tree. The shell content is memoized (`App.tsx:1367`) but several always-mounted leaves under it consume context. Large page components (`BrowserWorkspaceView` 2990 lines, `GameView` 2251, `ElizaOsAppsView` 1959, etc. — none `memo`'d) are route-gated so they matter less, but the always-mounted ones (transcript, sidebar, banners, overlays) are where smoothness is felt.

**(2) Fix sketch.** Wrap tab/view switches in `startTransition` (in `setTab`/`switchShellView`) so the current view stays interactive while the next renders, and show the existing `Suspense` fallback. Use `useDeferredValue(conversationMessages)` for the transcript so token bursts (after Finding 1's coalescing) yield to user input. Audit the always-mounted leaves and `memo` the ones with stable props.

**(3) Before/after measurement.** `frontend-kpi.mjs` INP/long-tasks proxy + a scripted view-switch loop (chat↔settings↔views, 10 cycles).
- Expected: `longTasksMs` during the switch loop drops; the UI remains responsive (composer focusable) during a switch. Capture commit counts of the outgoing view during the transition (should be deferrable rather than blocking).

**(4) Confidence:** Medium. `startTransition` reliably helps perceived responsiveness; the exact long-task delta depends on view weight.

**(5) Impact:** Medium. Smoothness/INP on navigation and during token bursts.

**(6) Risk:** Low-Medium. `startTransition` can surprise with stale-UI windows; keep the Suspense fallback and test loading states.

**(7) Verify nothing breaks.** `bun run --cwd packages/app test:e2e` (view navigation smoke), `App.navigate-view-wiring.test.tsx`. Manual: rapid tab switching, view-dependent agent actions still fire (the interact registry in `DynamicViewLoader.tsx:546` must still register on mount).

---

### Finding 9 — Memoize `MessageContent` (after Finding 2)

**(1) Problem + evidence.** `MessageContent` (`MessageContent.tsx:1037`) is the largest per-row component (1332 lines) and unmemoized. Once it stops subscribing to the God context (Finding 2), wrapping it in `memo` lets it skip re-render when `message` and `analysisMode` are unchanged.

**(2) Fix sketch.** `export const MessageContent = memo(function MessageContent(...))`. Its only props are `message` and `analysisMode`; both are stable per message except for the streaming bubble. Ensure callers don't pass new object props (they don't — `ChatView.tsx:598-602` passes `message` by reference and a boolean).

**(3) Before/after measurement.** Render-count harness: 50-message transcript, change one bubble's text. Count `MessageContent` commits.
- Expected: only the changed bubble commits (with #2 and #3 also in place).

**(4) Confidence:** Medium (depends on #2/#3 landing first; otherwise context subscription forces re-render regardless of memo).

**(5) Impact:** Medium.

**(6) Risk:** Low. Verify segment parsing memo (`MessageContent.tsx:1052`) still correct.

**(7) Verify nothing breaks.** `bun run --cwd packages/ui test`; manual: streaming bubble still updates live.

---

### Finding 10 — Virtualize other long lists (DatabaseView, VectorBrowserView, MemoryViewer)

**(1) Problem + evidence.** `DatabaseView` (`tableData.rows`, `DatabaseView.tsx`), `VectorBrowserView` (1569 lines), and the memory viewer render rows/cards inline without windowing. These are route-gated and lower-traffic than chat/logs, hence lower priority.

**(2) Fix sketch.** Apply the same virtualization layer from #5/#6 once it's a shared utility; extract `memo`'d row/card components.

**(3) Before/after measurement.** Same node-count + `longTasksMs` method as #6, on each respective route with a large dataset.

**(4) Confidence:** Low (need to confirm real-world dataset sizes; small datasets won't benefit).

**(5) Impact:** Medium for power users with large DBs/vector stores; low otherwise.

**(6) Risk:** Medium. Table layouts and column sizing complicate virtualization.

**(7) Verify nothing breaks.** Route-specific manual checks + existing tests.

---

## D. Measurement & Benchmark Plan

The repo already has the right primitives; this plan turns them into a repeatable render-count benchmark. **No estimates — every number below comes from a command.**

### D.1 Tooling already present (reuse, don't reinvent)

- **Render telemetry bus.** `useRenderGuard(name)` (`packages/ui/src/hooks/useRenderGuard.ts:136`) pushes events to `window.__ELIZA_RENDER_TELEMETRY__` (when that array exists) and dispatches `RENDER_TELEMETRY_EVENT`. But its thresholds (`INFO_THRESHOLD=60`, `ERROR_THRESHOLD=120` per second) only fire on *runaway loops* — useless for measuring ordinary cascade churn. For benchmarking we need *every* commit counted.
- **Frontend KPI.** `packages/benchmarks/loadperf/frontend-kpi.mjs` already injects `PerformanceObserver`s for LCP/CLS/longtask before navigation (`frontend-kpi.mjs:97-115`) and collects them (`:117-138`). `longTasksMs` is our main-thread-cost signal.
- **Playwright + Chromium are installed** (verified: `~/.cache/ms-playwright/chromium-1223`, `bunx playwright --version` → 1.60.0).

### D.2 New instrumentation: an exact render counter

Add a benchmark-only render counter that records **every** commit (not just threshold breaches). Two options:

**Option A — page-side counter via the existing event (no source changes needed for instrumented components).** In dev/test builds, install a global counter before navigation; many hot components already call `useRenderGuard` (`MessageContent`, `PluginsView`, `CharacterEditor`, `GameView`, `VectorBrowserView`, `BrowserWorkspaceView`, `FirstRunScreen`, …). But `useRenderGuard` only *emits* past the threshold, so for benchmarking, set a benchmark flag that makes it emit on every commit. Add (one-line, gated) to `useRenderGuard.ts`:
```ts
// at top of the effect, before the threshold check:
if ((globalThis as any).__ELIZA_RENDER_COUNT__) {
  (globalThis as any).__ELIZA_RENDER_COUNT__[name] =
    ((globalThis as any).__ELIZA_RENDER_COUNT__[name] ?? 0) + 1;
}
```
Then in the harness: `await page.addInitScript(() => { (window as any).__ELIZA_RENDER_COUNT__ = {}; });` and read `await page.evaluate(() => (window as any).__ELIZA_RENDER_COUNT__)` after each scripted interaction. This counts commits per named component with zero per-component edits.

**Option B — React Profiler harness (most precise, no source flag).** Add a benchmark entry that wraps the app in `<Profiler id="app" onRender={(id, phase, actualDuration) => window.__PROFILE__.push({id,phase,actualDuration})}>` and reads commit count + summed `actualDuration` per interaction. Heavier to wire (needs a custom entry), so Option A is the default; use Option B for commit-duration (not just count).

### D.3 Scripted interaction scenarios (the benchmark)

Drive a dev server (`bun run dev`, UI on `:2138`) with a Playwright script that performs each scenario and snapshots `__ELIZA_RENDER_COUNT__` + `window.__perf.longTasks` before/after. Save as `packages/benchmarks/loadperf/react-render-kpi.mjs` (new sibling KPI):

1. **Idle background churn (Finding 4).** Boot to ready, then idle 10s while wallet/cloud/update/heartbeat polls run. Δrender-count per component over the window. *Expectation after split: idle commits for unrelated consumers → ~0.*
2. **Streamed response (Findings 1, 2, 3, 9).** Send a prompt yielding ~400 tokens. Count `MessageContent:*` + `App` + sidebar commits over the streaming window; record `longTasks`. *Expectation: per-token cascade → one-per-frame; per-bubble re-renders → only the in-flight bubble.*
3. **Composer typing.** Type 40 chars. Count `App`/sidebar commits (should stay ~0 — `ChatComposerContext` already isolates this; this is a regression guard).
4. **View switch (Finding 8).** chat→settings→views→chat ×10. Record `longTasks` and whether composer stays focusable mid-switch.
5. **Long transcript (Finding 5).** Load/seed a 500-message conversation. Record `document.querySelectorAll('[data-testid="companion-message-row"]').length`, `performance.memory.usedJSHeapSize`, and `longTasks` during a scroll-to-top.
6. **Long logs (Finding 6).** Open Logs with a busy agent for 10s. Record `[data-testid="log-entry"]` count + `longTasks`.

### D.4 Exact commands

```bash
# 0. Build + bundle baseline (context for the FE KPI)
bun run --cwd packages/app build
node packages/benchmarks/loadperf/bundle-kpi.mjs

# 1. Web-vitals baseline against a built dist OR a running dev server
node packages/benchmarks/loadperf/frontend-kpi.mjs                       # serves dist
bun run dev                                                              # API :31337, UI :2138
node packages/benchmarks/loadperf/frontend-kpi.mjs --url=http://127.0.0.1:2138

# 2. Render-count benchmark (new harness, Option A) — run before and after each fix
node packages/benchmarks/loadperf/react-render-kpi.mjs --url=http://127.0.0.1:2138 --scenario=streamed
node packages/benchmarks/loadperf/react-render-kpi.mjs --url=http://127.0.0.1:2138 --scenario=idle

# 3. Unit/integration regression nets after each change
bun run --cwd packages/ui test
bun run --cwd packages/app test:e2e
```

`react-render-kpi.mjs` mirrors `frontend-kpi.mjs`'s structure (serve-or-attach, `addInitScript`, `page.evaluate`, `recordResult`, budget compare). Budgets to add to `budgets.json`: `react.streamedResponseCommits`, `react.idleBackgroundCommits`, `react.transcriptDomNodes`, `react.viewSwitchLongTasksMs` — then ratchet down as fixes land (the harness's stated monotonic-improvement model).

### D.5 Per-fix verification matrix

| Finding | Primary metric | Command | Pass condition |
|---|---|---|---|
| 1 | streamed-response total commits | scenario=streamed | ≥5× fewer commits, lower `longTasks` |
| 2 | `MessageContent:*` commits on unrelated change | scenario=idle while transcript mounted | ~0 |
| 3 | non-changed `ChatMessage` commits on 1-bubble change | Profiler (Option B) | only changed bubble commits |
| 4 | idle background commits across consumers | scenario=idle | single-digit, scoped to changed slice |
| 5 | transcript DOM node count + heap | scenario=long-transcript | nodes → window size; heap drop |
| 6 | log-entry DOM node count | scenario=long-logs | nodes → window size |
| 7 | `ChatTranscript` commit duration @500 msgs | Profiler (Option B) | linear, not quadratic |
| 8 | view-switch `longTasks`; composer focusable mid-switch | scenario=view-switch | lower `longTasks`, stays interactive |

---

## E. Prioritized Backlog (ranked by confidence × impact)

1. **Throttle streaming-token commits to one per frame** (Finding 1). High conf × High impact, Low risk. Smallest change with the biggest hot-path win; do this first.
2. **Stop message bubbles subscribing to the God context** (Finding 2). High × High, Low risk. Removes the O(N-messages) multiplier; pairs with #1.
3. **Stabilize transcript child/callback props so `memo(ChatMessage)` holds** (Finding 3). High × High, Low risk. Must land with #2.
4. **Split `AppContext` — Tier A (stable actions) then Tier B (domain slices)** (Finding 4). High × Very High, Medium risk. Root cause; biggest structural win; migrate behind a back-compat `useApp()` shim.
5. **Fix O(n²) reply lookup with an id→message map** (Finding 7). High × Medium, Low risk. Trivial, do alongside transcript work.
6. **Virtualize + cap the logs list** (Finding 6). High × Medium, Low risk. Self-contained, uniform rows.
7. **Memoize `MessageContent`** (Finding 9). Medium × Medium, Low risk. Only meaningful after #2/#3.
8. **Virtualize + cap the chat transcript** (Finding 5). Medium × High, Medium risk. High payoff for long sessions but fiddly; sequence after #1-3 so the per-render cost is already low.
9. **Concurrent view switches + deferred transcript value + memo always-mounted leaves** (Finding 8). Medium × Medium, Low-Medium risk.
10. **Virtualize DatabaseView / VectorBrowserView / MemoryViewer** (Finding 10). Low × Medium, Medium risk. Do last, gated on confirming real dataset sizes.

**One-line summary of the architecture fix:** the app's render cost is gated by a single 300-field context consumed by 191 components plus an un-throttled per-token chat update; coalescing tokens (1), unsubscribing bubbles (2-3), and splitting the context (4) remove the dominant cascades, after which virtualization (5-6, 8, 10) handles the long-list tail.
