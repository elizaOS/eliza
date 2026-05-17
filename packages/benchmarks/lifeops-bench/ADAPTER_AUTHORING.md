# LifeOpsBench — Adapter Authoring Guide

How to add a new backend agent adapter to LifeOpsBench. The runner
calls every adapter through the same `AgentFn` contract, so a
correctly-wired adapter inherits all of the runner's orchestration:
turn loops, tool execution, cost capping, per-scenario timeouts,
LIVE-mode disruptions, scoring.

## Table of contents

- [The AgentFn contract](#the-agentfn-contract)
- [Cost and latency propagation](#cost-and-latency-propagation)
- [Tool-call format](#tool-call-format)
- [Reference implementations](#reference-implementations)
- [Registering the adapter in the CLI](#registering-the-adapter-in-the-cli)
- [The conformance test pattern](#the-conformance-test-pattern)

## The AgentFn contract

```python
from collections.abc import Awaitable, Callable
from typing import Any
from eliza_lifeops_bench.types import MessageTurn

AgentFn = Callable[
    [list[MessageTurn], list[dict[str, Any]]],
    Awaitable[MessageTurn],
]
```

Per call:

- `history` — the full conversation so far. The first turn is always
  `MessageTurn(role="user", content=scenario.instruction)`. Subsequent
  turns interleave `assistant` (your previous outputs), `tool` (the
  runner's executor results), and `user` (LIVE simulator or STATIC
  fallback).
- `tools` — a list of OpenAI-style JSON-Schema tool descriptors (Wave 4
  surfaces real per-action schemas; today this is an empty list — your
  adapter should still tolerate the shape).
- Returns: a single `MessageTurn` with `role="assistant"`. If the turn
  carries `tool_calls`, the runner executes them against the
  `LifeWorld` and threads the results back as `role="tool"` turns
  before calling you again. If `tool_calls` is empty/None, the turn is
  treated as a terminal response (the runner ends the scenario in
  STATIC mode after the optional fallback; LIVE mode advances the
  simulated user).

The function MUST be async. The runner uses `asyncio.gather` with a
configurable concurrency semaphore; the per-scenario timeout
(`--per-scenario-timeout-s`) wraps the entire scenario including all
agent turns, so make sure your adapter doesn't hang on a network
backoff.

## Cost and latency propagation

The runner reads four extra attributes off the returned `MessageTurn`
via `getattr` with a default of 0:

```python
turn = MessageTurn(role="assistant", content="…", tool_calls=[…])
turn.cost_usd = 0.000123        # type: ignore[attr-defined]
turn.latency_ms = 482           # type: ignore[attr-defined]
turn.input_tokens = 1234        # type: ignore[attr-defined]
turn.output_tokens = 56         # type: ignore[attr-defined]
return turn
```

If your adapter omits these, the runner sees zeros — the run still
completes correctly but the cost cap and per-domain cost reporting
will under-count your spend. The `_charge` path enforces
`--max-cost-usd` against the sum of per-turn `cost_usd`, so omitting
it disables cost capping for your adapter.

`OpenAICompatAgent` (in `agents/_openai_compat.py`) does this
plumbing for you when you wrap a `BaseClient` — it copies
`response.cost_usd / latency_ms / usage.prompt_tokens /
usage.completion_tokens` onto the returned turn automatically.

## Tool-call format

The runner accepts two shapes inside `MessageTurn.tool_calls`:

### OpenAI-nested (recommended)

```python
turn.tool_calls = [
    {
        "id": "call_001",
        "type": "function",
        "function": {
            "name": "CALENDAR",
            "arguments": '{"subaction":"create_event","title":"…"}',
        },
    }
]
```

`function.arguments` may be a JSON string (typical for OpenAI / Cerebras / Anthropic) or a dict; the runner's
`_extract_actions_from_turn` handles both. The `id` flows through to
the `tool_call_id` field on the resulting `tool` turn so the runner
can correlate results to calls.

### Flat (used by PerfectAgent)

```python
turn.tool_calls = [
    {"name": "CALENDAR", "arguments": {"subaction": "create_event", ...}},
]
```

Both shapes work. Provider adapters (Hermes, Cerebras, Eliza) use
nested; the reference oracles use flat for brevity.

The `HermesClient` handles the XML `<tool_call>` ↔ JSON translation
internally — your adapter only ever deals in OpenAI tool-calls
regardless of wire protocol. If you're integrating a new wire
protocol (e.g. Anthropic content blocks), do the translation inside
the client (subclass `BaseClient`), not the agent.

## Reference implementations

Read these in order:

- `agents/_openai_compat.py` — the shared `OpenAICompatAgent` wrapper. Handles message-turn ↔ OpenAI translation, lazy client construction, and per-instance `total_cost_usd` accounting.
- `agents/cerebras_direct.py` — the simplest adapter (~50 lines): construct a `CerebrasClient`, hand it to `OpenAICompatAgent`. Cerebras speaks native OpenAI tool-calls, so there's nothing else to do.
- `agents/hermes.py` — same shape as cerebras_direct, but the `HermesClient` does XML translation and system-prompt templating internally.
- `agents/__init__.py::build_eliza_agent` — the Eliza adapter delegates to `eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn`, which spawns the TS bench server and bridges over HTTP.

If you're adding a new OpenAI-compatible provider (e.g. Groq), the
right pattern is: implement a `BaseClient` subclass under
`clients/`, then write a thin `agents/<name>.py` that hands the
client to `OpenAICompatAgent`. ~50 lines total.

If you're adding a non-HTTP transport (subprocess, native Python
package), you implement the `AgentFn` directly and own the lifecycle
yourself — see `build_eliza_agent` for the spawn/teardown pattern
(uses `eliza_adapter.server_manager.ElizaServerManager` plus the
module-level `_ELIZA_SERVER_MANAGER` reference to keep the subprocess
alive).

## Registering the adapter in the CLI

Edit `eliza_lifeops_bench/__main__.py`:

1. Add the agent name to `_AGENT_CHOICES`:

   ```python
   _AGENT_CHOICES = (
       "perfect",
       "wrong",
       "eliza",
       "openclaw",
       "hermes",
       "cerebras-direct",
       "your-new-adapter",  # <-- here
   )
   ```

2. Add an import + builder branch in `_build_agent_fn`:

   ```python
   if name == "your-new-adapter":
       try:
           from .agents import build_your_new_adapter  # type: ignore[attr-defined]
       except ImportError as exc:
           raise SystemExit(
               f"your-new-adapter not yet wired: {exc}"
           ) from exc
       return build_your_new_adapter()
   ```

3. Re-export the builder from `agents/__init__.py`.

4. Document any required environment variables in the README's
   "Running with each backend" section.

## The conformance test pattern

Every adapter must pass `tests/test_adapter_conformance.py`. The
invariant: PerfectAgent-equivalent input → score 1.0, WrongAgent-
equivalent input → score 0.0. Both are exercised through the adapter's
wire path with a mocked client that returns deterministic tool_calls.

The mock pattern (read the file in full for the exact wiring):

```python
class _PerfectMock:
    """Deterministic mock that emits the next ground-truth action."""

    def __init__(self, scenario):
        self._actions = list(scenario.ground_truth_actions)
        self._cursor = 0
        self.total_cost_usd = 0.0

    async def complete(self, call):
        if self._cursor >= len(self._actions):
            # No more actions → terminal response.
            return ClientResponse(content="done", tool_calls=[], …)
        action = self._actions[self._cursor]
        self._cursor += 1
        return ClientResponse(
            content="",
            tool_calls=[ToolCall(id=f"c{self._cursor}", name=action.name, arguments=action.kwargs)],
            …,
        )
```

Then build your adapter against the mocked client, run it through the
runner against ≤5 STATIC scenarios per domain (sorted deterministically
by id), and assert `pass@1 == 1.0` for the perfect mock and
`pass@1 == 0.0` for the wrong mock.

Sampling rules (enforced by `_sample_scenarios()` in
`test_adapter_conformance.py`):

- STATIC mode only.
- Only scenarios where every ground-truth action name is in
  `runner.supported_actions()` (skips Wave 4C gaps).
- ≤5 per domain, sorted by `Domain.value` then by scenario id.

If your adapter passes both directions on this sample, the runner's
orchestration will work for the rest of the corpus too.

Live-LLM evaluation lives in `tests/test_live_scenarios.py` and is
gated on `CEREBRAS_API_KEY` + `ANTHROPIC_API_KEY`. Don't try to put
live calls in the conformance test — CI must run hermetically.

## Filtering tools by capability taxonomy

Every action in `manifests/actions.manifest.json` carries a canonical
set of taxonomy tags (see `docs/audits/lifeops-2026-05-09/14-capability-taxonomy.md`):

- `_domain` — one `domain:*` tag (calendar, mail, finance, …).
- `_capabilities` — one or more `capability:*` tags (read, write, send, …).
- `_surfaces` — one or more `surface:*` tags (remote-api, device, internal).
- `_risk` — zero or one `risk:*` tag (irreversible, financial, user-visible).
- `_cost` — zero or one `cost:*` tag (cheap, expensive).

An adapter can use these to scope the tool list it sends to the LLM. For
example, a `PerfectAgent`-equivalent that only wants calendar+meta tools
for a `Domain.CALENDAR` scenario can pre-filter:

```python
def filter_tools_for_scenario(tools: list[dict], scenario: Scenario) -> list[dict]:
    expected_domain = f"domain:{scenario.domain.value}"
    keep_domains = {expected_domain, "domain:meta"}
    return [
        t for t in tools
        if t.get("_domain") in keep_domains
    ]
```

The same approach works for sandboxed harnesses that must skip risky
actions:

```python
SAFE_RISKS = set()  # only allow actions with no risk tag
filtered = [t for t in tools if t.get("_risk") in (None, *SAFE_RISKS)]
```

The exporter exposes the same filters at generation time:

```bash
# Generate a calendar-only manifest
bun run scripts/lifeops-bench/export-action-manifest.ts \
  --domain calendar --out manifests/calendar.manifest.json

# Generate a sandboxed manifest excluding all dangerous actions
bun run scripts/lifeops-bench/export-action-manifest.ts \
  --capability read \
  --exclude-risk irreversible --exclude-risk financial --exclude-risk user-visible \
  --out manifests/safe.manifest.json
```

This is useful for CI runs where a misbehaving live agent must not be
able to send messages, charge cards, or block apps.
