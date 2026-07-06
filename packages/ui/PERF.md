# Chat rendering performance

The chat surface streams one assistant turn token-by-token while a long
transcript stays mounted. The invariant that keeps it smooth: **a streamed
token must re-render nothing but the tail turn** — not the historical rows, and
not the inline widgets inside the streaming turn. This document records the
mechanisms that hold that invariant and the measured numbers from the perf
suite that locks it.

## Where the cost is

Two things run on every streamed token:

1. **`MessageContent` re-parses the whole message body** (`parseSegments`). It
   scans the growing text for code fences, `[CONFIG]`/`[CHOICE]`/`[FORM]`/
   `[WORKFLOW]`/`[TASK]` markers, UiSpec JSON, and permission cards. This is
   pure string work and must scale ~linearly with message length.
2. **The transcript re-renders.** `ChatMessage` is memoized per row
   (`arePropsEqual`, issue #9141), so only the tail row's body re-runs. Inside
   that body, the inline widgets are memoized on their data props
   (`widget-equality.ts`), so a widget already on screen does not re-render as
   the surrounding prose grows.

## Memoized inline widgets

The transcript hands each inline widget a **fresh** data-derived props object on
every re-parse, so `React.memo`'s default referential check never bails. Each
widget therefore ships a value-level comparator:

| Widget | Comparator | Compares |
| --- | --- | --- |
| `ChoiceWidget` | `choicePropsEqual` | id, scope, allowCustom, options by value, `onChoose` by identity |
| `FollowupsWidget` | `followupsPropsEqual` | id, options by value, three callbacks by identity |
| `FormRequest` | `formRequestPropsEqual` | form spec by value, `onSubmit` by identity |
| `WorkflowSteps` | `workflowPropsEqual` | id, title, steps by value |
| `PlanChecklist` | `planChecklistPropsEqual` | entries by value, title |
| `TaskWidget` | default (shallow) | two primitive props (`threadId`, `fallbackTitle`) |

Callbacks come from the memoized `inlineWidgetCtx` (`useInlineWidgetContext`),
so they are stable references and a referential `===` on them is correct. For
`FormRequest` this is load-bearing: the form carries user-entered field state,
so a payload-equal re-parse must not remount it — otherwise a half-filled input
would be wiped mid-conversation.

The comparators are exported so the render-count regression test asserts against
the exact predicate each widget ships with.

## Measured numbers

Captured on an Apple-silicon dev machine (macOS, Node 24, Vitest 4). Absolute
numbers vary by machine; the perf tests assert **generous absolute budgets** and
**machine-independent scaling ratios** so they are stable on CI runners.

### `parseSegments` cost — `message-parser.bench.test.ts`

Mixed message bodies (prose + code fences + CHOICE markers), 200 measured
iterations after 20 warm-up:

| Input | Segments | Median | p95 |
| --- | --- | --- | --- |
| 5 KB | 29 | 0.097 ms | 0.178 ms |
| 50 KB | 288 | 0.958 ms | 1.508 ms |

**Scaling ratio: 9.88×** for a 10× input increase — linear. The test fails if
the 50 KB median exceeds 30× the 5 KB median (an accidental O(n²) parser lands
near 100×) or if the 50 KB median exceeds an absolute 50 ms.

### Transcript scale — `chat-transcript.scale.bench.test.tsx`

Streaming one token into the tail, with the whole transcript mounted:

| Transcript | Rows re-rendered on a streamed token | Streamed-token commit |
| --- | --- | --- |
| 500 messages | 1 (the tail only) | ~6.9 ms |
| 1000 messages | 1 (the tail only) | ~12.7 ms |

The re-rendered-row count is **1 regardless of transcript size** — the bounded
re-render invariant. Appending a brand-new turn mounts exactly one new row and
re-renders **zero** historical rows.

### Streaming perf gate — `run-chat-perf-gate.mjs`

Drives the real `ContinuousChatOverlay` at 420×820, then streams ~120 tokens
into the open chat (tail turn carries a CHOICE widget):

| Metric | Streaming window |
| --- | --- |
| Frames captured | 134 |
| FPS | 120.0 |
| p95 frame | 10.2 ms |
| Dropped frames | 0 / 134 |
| Layout shifts outside the chat overlay | **0** |
| CHOICE widget instances after the full stream | 1 (never remounted) |

The **no-reflow guard** is the key streaming assertion: every layout-shift source
during the stream must resolve inside `[data-testid="chat-sheet"]`. A shift
attributed to a node outside the overlay means the growing turn pushed the
surrounding page around — zero is the only pass.

## Regression locks

| File | Locks |
| --- | --- |
| `chat/widgets/inline-widget.render-count.test.tsx` | each widget is a `react.memo` wired to its exported comparator; a payload-equal re-parse does not re-render; a real change renders exactly once; `ChoiceWidget`/`FormRequest` state survives an equal re-parse |
| `chat/message-parser.bench.test.ts` | `parseSegments` absolute budget + linear-scaling ratio |
| `composites/chat/chat-transcript.scale.bench.test.tsx` | bounded per-token re-render at 500/1000 messages |
| `composites/chat/chat-transcript.render-count.test.tsx` (#9141) | fixed-size per-row memoization |
| `shell/__e2e__/run-chat-perf-gate.mjs` | live frame budget + layout stability for scroll/maximize/restore **and** streaming; no-reflow-outside-chat guard |

Run them:

```bash
bun run --cwd packages/ui test src/components/chat/widgets/inline-widget.render-count.test.tsx
bun run --cwd packages/ui test src/components/chat/message-parser.bench.test.ts
bun run --cwd packages/ui test src/components/composites/chat/chat-transcript.scale.bench.test.tsx
bun run --cwd packages/ui test:chat-perf-gate   # Playwright — boots the real overlay
```
