"""LifeOpsBench agent_fn backed by the OpenClaw CLI.

Mirrors :func:`hermes_adapter.lifeops_bench.build_lifeops_bench_agent_fn`:
the runner owns the in-memory ``LifeWorld`` and the executor. The adapter
just threads ``(history, tools) -> tool_calls`` through OpenClaw. World
state is discovered by the agent via tool calls — never inlined into the
prompt — which keeps prompts within model context limits and matches
how the eliza/hermes paths work.

Earlier revisions inlined the entire world snapshot (~2 MB JSON / ~900k
tokens for medium_seed_2026) into the system message every turn. That
exceeded gpt-oss-120b's 131k context and hit Windows' command-line
length cap on the CLI path; it also bypassed the tool-call discovery
the benchmark is designed to measure. The snapshot path is still
accepted for backward compatibility with ``__main__.py`` and the tests,
but it is no longer loaded or embedded.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable, Final

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


# Per-million-token USD pricing for Cerebras gpt-oss-120b. Matches
# ``hermes_adapter.lifeops_bench._CEREBRAS_PRICING`` and
# ``eliza_lifeops_bench.clients.cerebras.CEREBRAS_PRICING`` so that
# the runner's total_cost_usd matches the cerebras-direct upper bound
# when both adapters hit the same provider.
_CEREBRAS_PRICING: Final[dict[str, dict[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def _compute_cost_usd(
    model: str | None, prompt_tokens: int, completion_tokens: int
) -> float | None:
    """Return USD cost for a Cerebras completion.

    Returns :data:`None` when ``model`` is missing or unpriced — per
    AGENTS.md Cmd #8, "unpriced" is distinct from "free" and a silent
    ``0.0`` would conflate the two. The runner sums only non-None
    per-turn costs into ``total_cost_usd``.
    """
    if not model:
        return None
    # Accept both bare ("gpt-oss-120b") and namespaced ("cerebras/gpt-oss-120b")
    # model identifiers so callers can pass either form.
    key = model.rsplit("/", 1)[-1]
    pricing = _CEREBRAS_PRICING.get(key)
    if pricing is None:
        return None
    return (
        (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    )


DEFAULT_LIFEOPS_PREAMBLE = (
    "You are operating in LifeOpsBench. Use the exact action names and "
    "parameter schemas shown in your tool list — do not invent synonyms. "
    "Discover world state by calling the provided tools (e.g. "
    "CALENDAR.list_events, EMAIL.search) before assuming entity ids. "
    "Always search for existing records before creating new ones."
)


def build_lifeops_bench_agent_fn(
    *,
    client: OpenClawClient | None = None,
    world_snapshot_path: str | None = None,
    now_iso: str = "2026-05-10T12:00:00Z",
    model_name: str | None = None,
    system_prompt: str | None = None,
    inject_preamble: bool = True,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Create a LifeOpsBench-compatible ``agent_fn`` backed by OpenClaw.

    The returned coroutine has signature
    ``agent_fn(history: list[MessageTurn], tools: list[dict]) -> MessageTurn``
    so it plugs straight into ``LifeOpsBenchRunner``.

    ``world_snapshot_path`` is accepted but ignored — the LifeOpsBench
    runner owns the world and exposes it through the tool catalog. The
    parameter is preserved for backward compatibility with
    ``eliza_lifeops_bench.__main__`` and existing tests.
    """
    from eliza_lifeops_bench.types import (  # noqa: WPS433 — lazy
        MessageTurn,
        attach_usage_cache_fields,
    )

    if world_snapshot_path is not None:
        logger.debug(
            "[openclaw-lifeops] world_snapshot_path=%s accepted but ignored "
            "(runner owns the LifeWorld; agent discovers state via tools)",
            world_snapshot_path,
        )

    bridge = client or OpenClawClient()

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> Any:
        messages = _history_to_openai_messages(conversation_history)
        if not any(m.get("role") == "user" for m in messages):
            return MessageTurn(role="assistant", content="", tool_calls=None)

        # Most recent user text as a fallback for callers that ignore
        # context["messages"]; the threaded conversation in context is the
        # authoritative input.
        last_user_text = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user_text = str(m.get("content") or "")
                break

        # Inject preamble + (optional) custom system prompt on the first
        # turn only — we detect "first turn" by the absence of any prior
        # assistant role in the threaded history.
        first_turn = not any(m.get("role") == "assistant" for m in messages)
        if first_turn:
            system_chunks: list[str] = []
            if inject_preamble:
                system_chunks.append(DEFAULT_LIFEOPS_PREAMBLE)
            system_chunks.append(f"NOW: {now_iso}")
            if isinstance(system_prompt, str) and system_prompt.strip():
                system_chunks.append(system_prompt.strip())
            if system_chunks and not any(m.get("role") == "system" for m in messages):
                messages.insert(
                    0,
                    {"role": "system", "content": "\n\n".join(system_chunks)},
                )

        context: dict[str, object] = {"messages": messages}
        if tools:
            context["tools"] = tools
            context["tool_choice"] = "auto"

        start_ns = time.monotonic_ns()
        try:
            resp = bridge.send_message(last_user_text, context=context)
        except Exception as exc:
            logger.exception("[openclaw-lifeops] send_message failed")
            raise RuntimeError("OpenClaw LifeOps send_message failed") from exc
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
                args = entry.get("arguments")
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": args if isinstance(args, dict) else {},
                        },
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
        # OpenClaw exposes usage either at params['usage'] (OpenAI-compat mode)
        # or under params['_meta']['usage'] (CLI mode). Prefer the direct slot
        # and fall back to the meta blob so both transports surface cache.
        usage = resp.params.get("usage") if isinstance(resp.params, dict) else None
        if not isinstance(usage, dict):
            usage_meta = resp.params.get("_meta") if isinstance(resp.params, dict) else None
            usage = usage_meta.get("usage") if isinstance(usage_meta, dict) else None
        if isinstance(usage, dict):
            attach_usage_cache_fields(turn, usage)
        # Bug B mirror: the runner reads ``cost_usd`` directly off the
        # MessageTurn. Without this, every openclaw turn reports $0.00
        # despite real Cerebras spend. Mirror the hermes-adapter and
        # cerebras-direct pricing tables so totals line up across agents.
        #
        # Per AGENTS.md Cmd #8, ``cost_usd`` stays :data:`None` for
        # unpriced models rather than silently masquerading as a free
        # ``0.0`` call.
        in_tok_raw = getattr(turn, "input_tokens", None)
        out_tok_raw = getattr(turn, "output_tokens", None)
        in_tok = int(in_tok_raw) if isinstance(in_tok_raw, (int, float)) else 0
        out_tok = int(out_tok_raw) if isinstance(out_tok_raw, (int, float)) else 0
        pricing_model = model_name or getattr(bridge, "model", None)
        cost = _compute_cost_usd(pricing_model, in_tok, out_tok)
        setattr(turn, "cost_usd", float(cost) if cost is not None else None)
        return turn

    return _agent_fn


def _history_to_openai_messages(conversation_history: list[Any]) -> list[dict[str, Any]]:
    """Convert LifeOpsBench ``MessageTurn`` history into OpenAI chat shape.

    Preserves assistant ``tool_calls`` and tool-result ``tool_call_id`` /
    ``name`` so the model sees its own prior tool calls plus the
    corresponding tool results. Without this the model never observes
    execution feedback and re-emits the same call until ``max_turns``.
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
        item: dict[str, Any] = {
            "role": role,
            "content": "" if content is None else str(content),
        }
        if role == "assistant":
            tcs = (
                getattr(turn, "tool_calls", None)
                if not isinstance(turn, dict)
                else turn.get("tool_calls")
            )
            if isinstance(tcs, list) and tcs:
                item["tool_calls"] = tcs
                if not item["content"]:
                    item["content"] = None
        elif role == "tool":
            tcid = (
                getattr(turn, "tool_call_id", None)
                if not isinstance(turn, dict)
                else turn.get("tool_call_id") or turn.get("toolCallId")
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


__all__ = ["build_lifeops_bench_agent_fn"]
