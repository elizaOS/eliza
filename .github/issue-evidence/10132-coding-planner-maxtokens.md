# #10132 — eliza-code large single-file builds fail on Cerebras glm-4.7

## Root cause (request shape, confirmed — matches the issue's framing)

The eliza-code coding sub-agent drives builds through the runtime **planner loop**
(`packages/core/src/runtime/planner-loop.ts`). In coding mode
(`ELIZA_PLANNER_FULL_ACTION_SURFACE=1`, set by the eliza-code ACP server) the
planner already uses **native tool-calling** with `toolChoice:"required"` and
**no `responseFormat`/`responseSchema`** — i.e. there is *no* `json_object`
structured-output envelope on the coding path. The actual constrained envelope is
the planner's **per-call output-token cap**, hardcoded to:

```
const DEFAULT_PLANNER_MAX_TOKENS = 1024;          // planner-loop.ts
...
maxTokens: DEFAULT_PLANNER_MAX_TOKENS,            // every callPlanner() call
```

A single-file app is emitted as **one `FILE`/`WRITE` tool call whose entire file
body is a JSON-escaped argument**. The reference `packages/examples/code/tetris.html`
is **14,850 bytes ≈ 4,640 tokens once JSON-escaped** — far past 1024. So the
model's tool-call argument is **truncated mid-stream**: the call never completes
(the model "narrates then stops", nothing lands on disk) or the provider 400s.

This is exactly the success-rate-vs-filesize gradient the issue reports:

| build size | eliza-code (before) | why |
|---|---|---|
| simple file / code-run / multi-file / edit | 100% | small outputs fit under 1024 |
| moderate HTML (dice roller, ~2–3 KB) | ~25% | right at the 1024-token boundary |
| large HTML (tip calc / tetris, ~5–15 KB) | 0% | physically cannot fit in 1024 |

opencode on the **same** Cerebras `zai-glm-4.7` builds the large app 2/2 precisely
because it does not clamp the file-emitting completion to a chat-sized budget.

## Fix

Raise the planner's output-token cap **only in coding/full-surface mode**, leaving
chat planner turns at the cheap 1024 default. Env-overridable.

`packages/core/src/runtime/planner-loop.ts`:
- `isCodingFullSurfaceMode()` — single source of truth for the coding-mode signal
  (deduped the check that was inlined in `runPlannerLoop`).
- `DEFAULT_CODING_PLANNER_MAX_TOKENS = 16384` (~3.5× headroom over tetris.html),
  overridable via `ELIZA_CODING_PLANNER_MAX_TOKENS`.
- `resolvePlannerMaxTokens()` → 1024 for chat, the coding budget for coding mode.
- `callPlanner()` now uses `resolvePlannerMaxTokens()` instead of the hardcoded 1024.

The cap is a ceiling, not a target — small read/think iterations still emit only
what they need, so there is **no cost regression** for chat or for small coding
steps; only file-emitting turns use the headroom.

## Verification

Unit (deterministic, no key needed) — `packages/core/src/runtime/__tests__/planner-loop.test.ts`:
- `raises the planner output-token cap in coding/full-surface mode (#10132)` →
  asserts `maxTokens === 16384` when `ELIZA_PLANNER_FULL_ACTION_SURFACE=1`.
- `honors ELIZA_CODING_PLANNER_MAX_TOKENS in coding mode (#10132)` → override to 32768.
- Existing chat-mode test still asserts `maxTokens === 1024` (unchanged).

```
$ vitest run src/runtime/__tests__/planner-loop.test.ts
 Test Files  1 passed (1)
      Tests  57 passed (57)
```

## Live-LLM trajectory — N/A in this environment (re-run on the reference bot)

A live Cerebras `zai-glm-4.7` build trajectory could not be captured here: this
build host has **no Cerebras/OpenAI key** (only `ANTHROPIC_BASE_URL` is present).
The change is deterministic at the request-shaping layer and unit-proven. To close
the live-evidence loop, re-run the issue's `reliability-battery.mjs` large-app
matrix (tip calculator) on the live VPS reference bot — the same harness that
measured 0/4 before — and confirm it now matches opencode's success rate. The
single env knob to tune if a given model needs more/less is
`ELIZA_CODING_PLANNER_MAX_TOKENS`.
