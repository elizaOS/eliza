"""LifeOpsBench agent_fn backed by hermes-agent.

Mirrors ``eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn`` but routes
each user turn through :class:`HermesClient` instead of the elizaOS HTTP
bench server. Each turn spawns a one-shot hermes-agent invocation in the
hermes venv with the conversation's tool catalog injected via the OpenAI
``tools=`` parameter.

The adapter is deliberately thin — it owns no scenario state and treats the
hermes-agent venv as the source of truth for tool execution. LifeOpsBench's
state-hash scoring is delegated to whatever world-state fixture the caller
supplies via ``fixtures`` (this differs from the Eliza path, where the TS
bench server hydrates an in-memory fake backend).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable, Final

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


# Per-million-token USD pricing for Cerebras gpt-oss-120b. Matches
# ``eliza_lifeops_bench.clients.cerebras.CEREBRAS_PRICING`` so the bench
# runner's total_cost / mean_score-per-domain numbers match the
# cerebras-direct upper bound when both hit the same provider.
_CEREBRAS_PRICING: Final[dict[str, dict[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def _compute_cost_usd(model: str | None, prompt_tokens: int, completion_tokens: int) -> float:
    """Return USD cost for a Cerebras completion, or 0.0 for unpriced models."""
    if not model:
        return 0.0
    pricing = _CEREBRAS_PRICING.get(model)
    if pricing is None:
        return 0.0
    return (
        (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    )


def _history_to_openai_messages(conversation_history: list[Any]) -> list[dict[str, Any]]:
    """Convert LifeOpsBench ``MessageTurn`` history into OpenAI chat shape.

    Preserves assistant ``tool_calls`` and tool-result ``tool_call_id``/``name``
    so the model sees its own prior tool calls AND the corresponding tool
    results. Without this, the model never observes execution feedback and
    re-emits the same tool call until ``max_turns`` (Bug A in the audit).
    """
    out: list[dict[str, Any]] = []
    for turn in conversation_history:
        role = (
            getattr(turn, "role", None)
            or (turn.get("role") if isinstance(turn, dict) else None)
        )
        if role not in {"system", "user", "assistant", "tool"}:
            continue
        content = (
            getattr(turn, "content", None)
            if not isinstance(turn, dict)
            else turn.get("content")
        )
        item: dict[str, Any] = {"role": role, "content": "" if content is None else str(content)}
        if role == "assistant":
            tcs = (
                getattr(turn, "tool_calls", None)
                if not isinstance(turn, dict)
                else turn.get("tool_calls")
            )
            if isinstance(tcs, list) and tcs:
                item["tool_calls"] = tcs
        elif role == "tool":
            tcid = (
                getattr(turn, "tool_call_id", None)
                if not isinstance(turn, dict)
                else turn.get("tool_call_id")
            )
            if isinstance(tcid, str) and tcid:
                item["tool_call_id"] = tcid
            tname = (
                getattr(turn, "name", None)
                if not isinstance(turn, dict)
                else turn.get("name")
            )
            if isinstance(tname, str) and tname:
                item["name"] = tname
        out.append(item)
    return out


def build_lifeops_bench_agent_fn(
    *,
    client: HermesClient | None = None,
    scenario_yaml: dict[str, Any] | None = None,
    fixtures: dict[str, Any] | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Create a LifeOpsBench-compatible ``agent_fn`` backed by hermes-agent.

    The returned coroutine has signature
    ``agent_fn(history: list[MessageTurn], tools: list[dict]) -> MessageTurn``
    so it plugs into ``LifeOpsBenchRunner`` exactly like the eliza-adapter
    equivalent.
    """
    from eliza_lifeops_bench.types import MessageTurn  # noqa: WPS433 — lazy

    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)
    del scenario_yaml, fixtures  # currently unused; reserved for future state hooks

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> Any:
        # Thread the FULL conversation (user + assistant tool_calls + tool
        # results) so the model sees execution feedback and can finalize.
        # Without this, every turn re-issues the same call (Bug A).
        messages = _history_to_openai_messages(conversation_history)
        if not any(m.get("role") == "user" for m in messages):
            return MessageTurn(role="assistant", content="", tool_calls=None)

        # Surface text of the most recent user turn as ``send_message`` text
        # so subprocess-mode callers that ignore ``context["messages"]`` still
        # have a sensible last-user prompt to fall back to.
        last_user_text = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user_text = str(m.get("content") or "")
                break

        context: dict[str, object] = {"messages": messages}
        if tools:
            context["tools"] = tools
        if system_prompt:
            # Prepend system prompt to the threaded message list (only if the
            # caller didn't already include one in history).
            if not any(m.get("role") == "system" for m in messages):
                messages.insert(0, {"role": "system", "content": system_prompt})
            context["system_prompt"] = system_prompt

        start_ns = time.monotonic_ns()
        try:
            resp = bridge.send_message(last_user_text, context=context)
        except Exception as exc:
            logger.exception("[hermes-lifeops] send_message failed")
            raise RuntimeError("hermes LifeOps send_message failed") from exc
        latency_ms = (time.monotonic_ns() - start_ns) // 1_000_000

        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                args_raw = entry.get("arguments")
                if isinstance(args_raw, str):
                    args: object = args_raw
                elif isinstance(args_raw, dict):
                    args = dict(args_raw)
                else:
                    args = {}
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "type": "function",
                        "function": {"name": name, "arguments": args},
                    }
                )

        turn = MessageTurn(
            role="assistant",
            content=resp.text,
            tool_calls=tool_calls or None,
        )
        if model_name:
            setattr(turn, "model_name", model_name)
        setattr(turn, "latency_ms", int(latency_ms))
        # Surface usage + cache telemetry on the returned MessageTurn so the
        # LifeOpsBench runner can populate TurnResult.cache_read_input_tokens
        # / cache_creation_input_tokens / cache_hit_pct via getattr(). The
        # hermes-agent OpenAI-compat surface exposes:
        #   * OpenAI / Cerebras shape: usage.prompt_tokens_details.cached_tokens
        # Anthropic-shaped responses (cache_read_input_tokens /
        # cache_creation_input_tokens) are forwarded verbatim when present.
        usage = resp.params.get("usage") if isinstance(resp.params, dict) else None
        if isinstance(usage, dict):
            _attach_usage_cache_fields(turn, usage)
        # Bug B: usage IS returned by Cerebras but never priced. The runner
        # reads ``cost_usd`` directly off the MessageTurn via getattr; without
        # this, every turn reports $0.00 even though we spent real Cerebras
        # tokens. Mirror cerebras-direct's pricing table so totals match.
        in_tok = int(getattr(turn, "input_tokens", 0) or 0)
        out_tok = int(getattr(turn, "output_tokens", 0) or 0)
        pricing_model = model_name or bridge.model
        cost = _compute_cost_usd(pricing_model, in_tok, out_tok)
        setattr(turn, "cost_usd", float(cost))
        return turn

    return _agent_fn


def _attach_usage_cache_fields(turn: Any, usage: dict[str, Any]) -> None:
    """Parse OpenAI / Cerebras / Anthropic-shaped usage onto the MessageTurn.

    Sets ``input_tokens`` / ``output_tokens`` / ``cache_read_input_tokens`` /
    ``cache_creation_input_tokens`` / ``cache_supported`` as attributes on
    ``turn`` (via ``setattr``) so the LifeOpsBench runner can pick them up
    with ``getattr``. Cache fields stay ``None`` when the provider does not
    report them — per AGENTS.md Cmd #8, no silent ``0`` fallback.
    """
    prompt = usage.get("prompt_tokens")
    completion = usage.get("completion_tokens")
    # Anthropic shape: input_tokens / output_tokens.
    if not isinstance(prompt, (int, float)):
        prompt = usage.get("input_tokens")
    if not isinstance(completion, (int, float)):
        completion = usage.get("output_tokens")
    if isinstance(prompt, (int, float)):
        setattr(turn, "input_tokens", int(prompt))
    if isinstance(completion, (int, float)):
        setattr(turn, "output_tokens", int(completion))

    # OpenAI / Cerebras: usage.prompt_tokens_details.cached_tokens
    prompt_details = usage.get("prompt_tokens_details") or {}
    cache_read_raw = (
        prompt_details.get("cached_tokens")
        if isinstance(prompt_details, dict)
        else None
    )
    # Anthropic: cache_read_input_tokens at the usage root.
    if cache_read_raw is None:
        cache_read_raw = usage.get("cache_read_input_tokens")
    cache_creation_raw = usage.get("cache_creation_input_tokens")

    cache_read_value: int | None = (
        int(cache_read_raw) if isinstance(cache_read_raw, (int, float)) else None
    )
    cache_creation_value: int | None = (
        int(cache_creation_raw)
        if isinstance(cache_creation_raw, (int, float))
        else None
    )
    setattr(turn, "cache_read_input_tokens", cache_read_value)
    setattr(turn, "cache_creation_input_tokens", cache_creation_value)
    # Hermes-template servers fronting Cerebras gpt-oss-120b or Anthropic
    # support prompt caching; cache_supported is a hard-true here.
    setattr(turn, "cache_supported", True)
