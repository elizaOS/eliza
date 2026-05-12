"""LifeOpsBench agent_fn backed by hermes-agent.

Mirrors ``eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn`` but routes
each user turn through :class:`HermesClient` instead of the elizaOS HTTP
bench server. Each turn spawns a one-shot hermes-agent invocation in the
hermes venv with the conversation's tool catalog injected via the OpenAI
``tools=`` parameter.

The adapter is deliberately thin — it owns no scenario state and treats the
hermes-agent venv as the source of truth for tool execution.
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


def _compute_cost_usd(
    model: str | None, prompt_tokens: int, completion_tokens: int
) -> float | None:
    """Return USD cost for a Cerebras completion.

    Returns :data:`None` when ``model`` is missing or unpriced — per
    AGENTS.md Cmd #8, "unpriced" is distinct from "free" and a silent
    ``0.0`` would conflate the two. The runner sums only non-None per-turn
    costs into ``total_cost_usd``.
    """
    if not model:
        return None
    pricing = _CEREBRAS_PRICING.get(model)
    if pricing is None:
        return None
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


def _build_bench_preamble(
    tools: list[dict[str, Any]],
    world_context: dict[str, Any] | None = None,
) -> str:
    """Build a shape-hint preamble for hermes/openclaw bench sessions (P1-7).

    Injected as the first system turn before the scenario instruction so the
    agent knows:
    1. Exact action names and parameter schemas (use the tool list verbatim).
    2. The ``ENTITY`` contact-create convention (subaction=create with name/email).
    3. The search-before-write rule (look up existing records before creating).
    4. IDs of seeded contacts/events (when world_context is provided) so the
       agent can reference them directly without a search round-trip.

    This replaces zero-shot guessing with explicit context — the eliza-runtime
    adapter already receives personality prompts that cover this, so we skip
    it there and inject only here (hermes + openclaw).
    """
    lines: list[str] = [
        "You are operating in LifeOpsBench. Use the exact action names and "
        "parameter schemas shown in your tool list — do not invent synonyms. "
        "For contacts, use ENTITY with subaction='create' and provide name and "
        "email at the top level of the arguments object. "
        "Always search for existing records before creating new ones.",
    ]

    # Surface seeded contact IDs so the agent can reference them directly.
    if world_context:
        contacts = world_context.get("contacts", {})
        if contacts:
            snippets = [
                f"  {cid}: {c.get('display_name', '?')} <{c.get('primary_email', '?')}>"
                for cid, c in list(contacts.items())[:10]
            ]
            lines.append("Seeded contacts (use these IDs to reference existing people):")
            lines.extend(snippets)

        events = world_context.get("calendar_events", {})
        if events:
            snippets = [
                f"  {eid}: {e.get('title', '?')} @ {e.get('start', '?')}"
                for eid, e in list(events.items())[:10]
            ]
            lines.append("Seeded calendar events:")
            lines.extend(snippets)

    return "\n".join(lines)


def build_lifeops_bench_agent_fn(
    *,
    client: HermesClient | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
    inject_preamble: bool = True,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Create a LifeOpsBench-compatible ``agent_fn`` backed by hermes-agent.

    The returned coroutine has signature
    ``agent_fn(history: list[MessageTurn], tools: list[dict]) -> MessageTurn``
    so it plugs into ``LifeOpsBenchRunner`` exactly like the eliza-adapter
    equivalent.

    ``inject_preamble`` (default ``True``) prepends a shape-hint system
    message on the first turn of each new session so hermes/openclaw receive
    the same structural context that the eliza-runtime adapter gets via its
    personality prompts (P1-7). Set to ``False`` to disable for ablation runs.
    """
    from eliza_lifeops_bench.types import (  # noqa: WPS433 — lazy
        MessageTurn,
        attach_usage_cache_fields,
    )

    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)

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

        # P1-7: inject shape-hint preamble before the first user turn so
        # hermes/openclaw know the expected action names, the ENTITY.create
        # convention, and seeded object IDs. We only inject on the first turn
        # (no existing assistant turn) to avoid polluting multi-turn history.
        if inject_preamble and not any(m.get("role") == "assistant" for m in messages):
            preamble = _build_bench_preamble(list(tools) if tools else [])
            if preamble and not any(m.get("role") == "system" for m in messages):
                messages.insert(0, {"role": "system", "content": preamble})

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
            attach_usage_cache_fields(turn, usage)
        # Bug B: usage IS returned by Cerebras but never priced. The runner
        # reads ``cost_usd`` directly off the MessageTurn; without this,
        # every turn reports $0.00 even though we spent real Cerebras
        # tokens. Mirror cerebras-direct's pricing table so totals match.
        #
        # Per AGENTS.md Cmd #8: ``cost_usd`` stays :data:`None` when the
        # model is unpriced rather than silently masquerading as a free
        # ``0.0`` call.
        in_tok_raw = getattr(turn, "input_tokens", None)
        out_tok_raw = getattr(turn, "output_tokens", None)
        in_tok = int(in_tok_raw) if isinstance(in_tok_raw, (int, float)) else 0
        out_tok = int(out_tok_raw) if isinstance(out_tok_raw, (int, float)) else 0
        pricing_model = model_name or bridge.model
        cost = _compute_cost_usd(pricing_model, in_tok, out_tok)
        setattr(turn, "cost_usd", cost if cost is None else float(cost))
        return turn

    return _agent_fn


