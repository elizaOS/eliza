"""ClawBench agent_fn factory backed by the eliza benchmark server.

ClawBench is a single-turn scenario benchmark: given a scenario YAML and a
fixtures bundle (inbox, calendar, contacts, memory, ...), the agent answers
the scenario's prompt and the resulting response + tool_calls are scored
against a deterministic rubric in ``clawbench.scoring``.

This adapter mirrors the shape of ``hermes_adapter.clawbench`` and
``openclaw_adapter.clawbench`` so the multi-harness ClawBench runner can
swap between harnesses by import-string alone.

LLM calls are routed through :class:`eliza_adapter.client.ElizaClient`
against the elizaOS TS benchmark server. When ``ELIZA_BENCH_URL`` is
unset the factory auto-spawns the benchmark server via
:class:`eliza_adapter.server_manager.ElizaServerManager` exactly like
``eliza_adapter.lifeops_bench`` does.

The returned coroutine has signature::

    async def agent_fn(history: list[Any], tools: list[dict]) -> dict

returning a dict shaped like::

    {
        "text": str,
        "tool_calls": [{"id": str, "name": str, "arguments": dict|str}, ...],
        "thought": str | None,
        "usage": {"prompt_tokens": int, "completion_tokens": int, ...},
        "model_name": str | None,
        "cost_usd": float | None,
    }
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Awaitable, Callable, Final

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


# Per-million-token USD pricing for Cerebras gpt-oss-120b. Mirrors the table
# in ``hermes_adapter.lifeops_bench`` and ``openclaw_adapter`` so multi-harness
# ClawBench numbers are directly comparable.
_CEREBRAS_PRICING: Final[dict[str, dict[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def _compute_cost_usd(
    model: str | None, prompt_tokens: int, completion_tokens: int
) -> float | None:
    """Return USD cost for a Cerebras completion, or :data:`None` when unpriced."""
    if not model:
        return None
    pricing = _CEREBRAS_PRICING.get(model)
    if pricing is None:
        return None
    return (
        (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    )


def _last_user_text(conversation_history: list[Any]) -> str:
    for turn in reversed(conversation_history):
        role = (
            getattr(turn, "role", None)
            or (turn.get("role") if isinstance(turn, dict) else None)
        )
        content = (
            getattr(turn, "content", None)
            or (turn.get("content") if isinstance(turn, dict) else "")
        )
        if role == "user":
            return str(content or "")
    return ""


def _compose_message(
    *,
    scenario_prompt: str,
    fixtures: dict[str, Any],
    user_text: str,
    system_prompt: str | None,
) -> str:
    """Build a single user message bundling scenario prompt + fixtures."""
    chunks: list[str] = []
    if system_prompt:
        chunks.append(system_prompt.strip())
    if scenario_prompt.strip():
        chunks.append(scenario_prompt.strip())
    if fixtures:
        chunks.append(
            "BENCHMARK CONTEXT:\n" + json.dumps(fixtures, ensure_ascii=True, indent=2)
        )
    if user_text.strip():
        chunks.append(user_text.strip())
    return "\n\n".join(chunk for chunk in chunks if chunk)


def build_clawbench_agent_fn(
    *,
    client: ElizaClient | None = None,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any] | None = None,
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build a ClawBench-compatible async ``agent_fn`` backed by eliza-runtime.

    Args:
        client: Optional preconfigured :class:`ElizaClient`. When omitted and
            ``ELIZA_BENCH_URL`` is unset, the factory auto-spawns the TS
            benchmark server via :class:`ElizaServerManager`.
        scenario_yaml: Parsed ClawBench scenario manifest. The factory reads
            ``scenario_yaml.get("prompt")`` and ``scenario_yaml.get("system_prompt")``.
        fixtures: Pre-attached fixture data inlined into the user message as a
            ``BENCHMARK CONTEXT`` JSON block. ClawBench scenarios assume the
            agent reads fixtures from this block rather than calling tools to
            fetch them.
        model_name: Optional label propagated into the returned dict for cost
            attribution.
    """
    scenario_prompt = scenario_yaml.get("prompt") if isinstance(scenario_yaml, dict) else None
    if not isinstance(scenario_prompt, str):
        scenario_prompt = ""
    system_prompt = scenario_yaml.get("system_prompt") if isinstance(scenario_yaml, dict) else None
    if not isinstance(system_prompt, str):
        system_prompt = None
    fixtures_dict: dict[str, Any] = dict(fixtures or {})

    # Mirror lifeops_bench.py auto-spawn logic — only spawn when no external
    # ELIZA_BENCH_URL is set, the user didn't pass a client, and we aren't
    # being delegated to another transport.
    server_manager = None
    if client is not None:
        bridge = client
    else:
        bridge = ElizaClient()
        harness = (
            os.environ.get("ELIZA_BENCH_HARNESS")
            or os.environ.get("BENCHMARK_HARNESS")
            or "eliza"
        ).strip().lower()
        if (
            getattr(bridge, "_delegate", None) is None
            and not os.environ.get("ELIZA_BENCH_URL")
            and harness in {"", "eliza"}
        ):
            from eliza_adapter.server_manager import ElizaServerManager  # noqa: WPS433

            server_manager = ElizaServerManager()
            server_manager.start()
            bridge = server_manager.client
    bridge.wait_until_ready(timeout=120)

    scenario_name = (
        scenario_yaml.get("name")
        if isinstance(scenario_yaml, dict)
        else None
    )
    if not isinstance(scenario_name, str) or not scenario_name:
        scenario_name = "clawbench"
    task_id: str | None = None
    reset_done = False

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        nonlocal task_id, reset_done

        last_user_text = _last_user_text(conversation_history)
        composed = _compose_message(
            scenario_prompt=scenario_prompt,
            fixtures=fixtures_dict,
            user_text=last_user_text,
            system_prompt=system_prompt,
        )
        if not composed:
            return {"text": "", "tool_calls": [], "thought": None}

        if task_id is None:
            task_id = f"clawbench-{scenario_name}-{uuid.uuid4().hex[:8]}"
        if not reset_done:
            try:
                bridge.reset(task_id=task_id, benchmark="clawbench")
                reset_done = True
            except Exception:
                # The TS server doesn't necessarily require a reset for the
                # generic /message route — log and continue.
                logger.debug("[eliza-clawbench] reset failed (continuing)", exc_info=True)
                reset_done = True

        context: dict[str, object] = {
            "benchmark": "clawbench",
            "scenario": scenario_name,
            "task_id": task_id,
        }
        if tools:
            context["tools"] = tools
        if system_prompt:
            context["system_prompt"] = system_prompt
        if fixtures_dict:
            # Surface fixtures structurally too (in addition to the inline
            # BENCHMARK CONTEXT block) so server-side scoring/telemetry can
            # see them. The TS bench server passes context through verbatim.
            context["fixtures"] = fixtures_dict
        if model_name:
            context["model_name"] = model_name

        try:
            resp = bridge.send_message(text=composed, context=context)
        except Exception as exc:
            logger.exception("[eliza-clawbench] send_message failed")
            raise RuntimeError("Eliza ClawBench send_message failed") from exc

        # Normalize tool calls into the shape the multi-harness runner reads.
        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                # Tool calls from eliza can be either flat ({"name", "arguments"})
                # or OpenAI-shaped ({"function": {"name", "arguments"}}).
                fn = entry.get("function") if isinstance(entry.get("function"), dict) else {}
                name = (
                    entry.get("name")
                    or entry.get("tool")
                    or entry.get("tool_name")
                    or fn.get("name")
                )
                if not isinstance(name, str) or not name.strip():
                    continue
                args_raw = (
                    entry.get("arguments")
                    if "arguments" in entry
                    else entry.get("args")
                    if "args" in entry
                    else fn.get("arguments")
                )
                if isinstance(args_raw, str):
                    try:
                        args: Any = json.loads(args_raw)
                    except (TypeError, ValueError):
                        args = args_raw
                else:
                    args = args_raw if isinstance(args_raw, dict) else {}
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "name": name.strip(),
                        "arguments": args,
                    }
                )

        # Fall back to captured actions if no tool_calls were surfaced.
        if not tool_calls:
            for action in getattr(resp, "actions", []) or []:
                if not isinstance(action, str) or not action:
                    continue
                params = resp.params if isinstance(resp.params, dict) else {}
                action_args = params.get(action, {})
                if not isinstance(action_args, dict):
                    action_args = {}
                tool_calls.append(
                    {
                        "id": f"call_{len(tool_calls)}",
                        "name": action,
                        "arguments": action_args,
                    }
                )

        usage = resp.params.get("usage") if isinstance(resp.params, dict) else None
        if not isinstance(usage, dict):
            usage = {}

        # Cerebras (and the OpenAI compat surface eliza-runtime uses) emit
        # both ``prompt_tokens``/``completion_tokens`` AND the camelCase
        # variants. Normalize to snake_case for downstream consumers.
        prompt_tokens_raw = (
            usage.get("prompt_tokens")
            if usage.get("prompt_tokens") is not None
            else usage.get("promptTokens")
        )
        completion_tokens_raw = (
            usage.get("completion_tokens")
            if usage.get("completion_tokens") is not None
            else usage.get("completionTokens")
        )
        prompt_tokens = int(prompt_tokens_raw) if isinstance(prompt_tokens_raw, (int, float)) else 0
        completion_tokens = (
            int(completion_tokens_raw)
            if isinstance(completion_tokens_raw, (int, float))
            else 0
        )

        cost = _compute_cost_usd(model_name, prompt_tokens, completion_tokens)

        result: dict[str, Any] = {
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
            },
        }
        if model_name:
            result["model_name"] = model_name
        if cost is not None:
            result["cost_usd"] = float(cost)
        return result

    # Keep server manager alive for as long as the callable is alive — it also
    # registers atexit cleanup.
    setattr(_agent_fn, "_eliza_server_manager", server_manager)
    return _agent_fn


__all__ = ["build_clawbench_agent_fn"]
