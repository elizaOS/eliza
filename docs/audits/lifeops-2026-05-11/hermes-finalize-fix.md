# Hermes finalize-loop and token-usage propagation fix — W1-10

## Symptoms

W1-3's baseline run at
`~/.eliza/runs/lifeops/lifeops-hermes-baseline-1778514429/lifeops_gpt-oss-120b_20260511_085043.json`
exposed two related bugs in the LifeOpsBench hermes adapter:

- **Bug A (no finalize).** Most scenarios reached `max_turns` (~8) with the
  agent re-emitting the same tool call every turn. Example trajectory for
  `smoke_static_calendar_01`:

  ```
  turn 1  BLOCK(name="deep work", duration_minutes=30, start_time="2026-05-12T10:00:00Z")
  turn 2  BLOCK(name="deep work", duration_minutes=30, start_time="2026-05-12T10:00:00Z")
  turn 3  BLOCK(...)        # identical
  ...
  turn 8  BLOCK(...)        # identical → max_turns
  ```

- **Bug B (zero cost telemetry).** Every `TurnResult` reported
  `cost_usd: 0.0`, even though `input_tokens` / `output_tokens` were
  populated. Cerebras IS returning real `usage` blocks; pricing was just
  never applied.

## Root cause

### Bug A — finalize loop

`packages/benchmarks/hermes-adapter/hermes_adapter/lifeops_bench.py:_agent_fn`
extracted only the **last user turn** from `conversation_history` and
passed it as the user message. The LifeOpsBench runner threads tool
results into history as `MessageTurn(role="tool", ...)` entries, but the
adapter discarded them. Consequence: every call to
`chat.completions.create()` saw only `[user]` — the model never observed
its own prior tool call OR the corresponding tool result, so it
re-emitted the same call until the runner gave up at `max_turns`.

### Bug B — token usage propagation

`_agent_fn` parsed `resp.params["usage"]` and attached `input_tokens` /
`output_tokens` to the returned `MessageTurn`, but never computed
`cost_usd`. The runner reads `cost_usd` directly off the turn via
`getattr(agent_turn, "cost_usd", 0.0)`, so the headline number stayed at
$0.00.

## Files changed

- `packages/benchmarks/hermes-adapter/hermes_adapter/lifeops_bench.py`
  - Added `_history_to_openai_messages(...)` helper that converts the
    runner's `MessageTurn` list into OpenAI chat shape, preserving
    `tool_calls` (assistant) and `tool_call_id`/`name` (tool result).
  - `_agent_fn` now passes the full message history via
    `context["messages"]` (canonical pattern matching
    `openclaw_adapter/client.py:_messages_from_context`).
  - Added `_CEREBRAS_PRICING` constant (mirror of
    `eliza_lifeops_bench.clients.cerebras.CEREBRAS_PRICING`: $0.35/M
    input, $0.75/M output for `gpt-oss-120b`) and `_compute_cost_usd(...)`.
  - `_agent_fn` measures wall-clock latency around `bridge.send_message`
    and attaches `cost_usd` + `latency_ms` to the returned MessageTurn.

- `packages/benchmarks/hermes-adapter/hermes_adapter/client.py`
  - Added module-level `_build_openai_messages(...)` helper that
    preserves `tool_calls` and `tool_call_id` when expanding
    `context["messages"]` into the chat-completions request.
  - `_send_in_process` delegates to that helper.
  - The subprocess-mode `_SEND_MESSAGE_SCRIPT` (the string-encoded script
    that runs inside the hermes-agent venv) now performs the same
    threading inline.

Both transports (`mode="in_process"` and `mode="subprocess"`) are
covered.

## Before/after

### Before (W1-3 baseline)

```jsonc
// smoke_static_calendar_01, turn 1
{
  "turn_number": 1,
  "agent_actions": [{"name": "BLOCK", "kwargs": {...}}],
  "input_tokens": 1316,
  "output_tokens": 234,
  "cost_usd": 0.0,         // ← bug B
  "latency_ms": 0
}
// turn 2 emits the same BLOCK call. Continues for 8 turns until
// terminated="max_turns" (bug A).
```

### After

```jsonc
// smoke_static_calendar_01, turn 1
{
  "turn_number": 1,
  "agent_actions": [{"name": "BLOCK", "kwargs": {...}}],
  "input_tokens": 1316,
  "output_tokens": 127,
  "cost_usd": 0.00055585,
  "latency_ms": 1076
}
// turn 2 — model sees tool result, finalizes:
{
  "turn_number": 2,
  "agent_message": "✅ Your 30-minute focus block \"deep work\" is scheduled for tomorrow, May 12 2026 at 10:00 UTC. Let me know if you'd like anything else!",
  "agent_actions": [],
  "input_tokens": 1387,
  "output_tokens": 78,
  "cost_usd": 0.00054395,
  "latency_ms": 2581
}
// terminated_reason: "respond"
```

## Sanity rerun (5 scenarios)

| Scenario                                       | turns | terminated | score      | cost USD |
| ---------------------------------------------- | ----- | ---------- | ---------- | -------- |
| `smoke_static_calendar_01`                     | 2     | respond    | 0.0/1.0    | $0.0011  |
| `calendar.reschedule_roadmap_sync_to_afternoon` | 8     | max_turns  | 0.2/1.0    | $0.0052  |
| `calendar.cancel_tentative_launch_checklist`   | 6     | max_turns  | 0.2/1.0    | $0.0037  |
| `calendar.find_free_60min_this_week`           | 2     | respond    | 0.0/1.0    | $0.0015  |
| `calendar.check_availability_thursday_morning` | 3     | respond    | **0.8/1.0** | $0.0018 |

Key observations:

- 3 of 5 scenarios now terminate naturally on `respond` (the bug-A loop
  is gone).
- The 2 scenarios that still hit `max_turns` now show **varied** tool
  calls (`delete_event` → `search_events` → varied criteria), proving
  the model is now reacting to tool results — it just doesn't converge
  on this benchmark's expected ground truth within 8 turns. That's a
  separate agent-quality finding, not the broken-loop bug.
- `calendar.check_availability_thursday_morning` scores 0.8 — confirms
  the runner's downstream scoring works once the agent gets to actually
  finalize.
- Every turn now carries non-zero `cost_usd` and `latency_ms` matching
  cerebras-direct's pricing constants ($0.35/M input, $0.75/M output).

## Verification

- `cd packages/benchmarks/hermes-adapter && pytest tests/ -q` → 53 passed.
- `cd packages/benchmarks/lifeops-bench && pytest tests/test_adapter_conformance.py -q`
  → 313 passed.
- Pre-existing `tests/test_hermes_agent.py::test_build_hermes_agent_returns_open_ai_compat_agent`
  failure is unrelated (also fails on `develop` without these changes —
  it asserts the legacy `build_hermes_agent` agent type which W1-8 / the
  cerebras-direct migration already deprecated).

## Followups

- The `max_turns` exits for `calendar.cancel_tentative_launch_checklist`
  and `calendar.reschedule_roadmap_sync_to_afternoon` likely indicate
  scoring-rubric or world-fixture mismatches (Hermes uses different
  subaction/argument shapes than the ground-truth scenarios expect).
  Hand this to W2 (scoring) rather than the adapter.
- `cache_creation_input_tokens` is still `null` for Cerebras (the
  provider doesn't surface it; `cached_tokens` covers the read side).
  No change needed — runner already treats `None` as "not reported"
  (per AGENTS.md Cmd #8).
- `latency_ms` is now measured around `bridge.send_message` from the
  adapter side, which includes serialization overhead. If we ever need
  pure-network latency, surface it via the OpenAI completion response
  headers instead. Current shape is good enough for the bench summary.
