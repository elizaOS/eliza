"""Hermes adapter for LifeOpsBench.

Wraps :class:`HermesClient` into an :class:`OpenAICompatAgent`
that the runner can drive. The client itself owns the Hermes XML
``<tool_call>`` / ``<tool_response>`` translation and the system-prompt
template — this adapter just funnels the runner's ``MessageTurn`` history
into the client and unpacks the response back into a ``MessageTurn`` with
cost/latency telemetry attached.
"""

from __future__ import annotations
from typing import Any, Awaitable, Callable

from ..types import MessageTurn
from .adapter_paths import ensure_benchmark_adapter_importable


class HermesLifeOpsAgent:
    """Callable wrapper that adds runner-readable cumulative telemetry."""

    def __init__(
        self,
        inner: Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]],
    ) -> None:
        self._inner = inner
        self.total_cost_usd: float = 0.0
        self.total_input_tokens: int = 0
        self.total_output_tokens: int = 0

    async def __call__(
        self,
        history: list[MessageTurn],
        tools: list[dict[str, Any]],
    ) -> MessageTurn:
        turn = await self._inner(history, tools)
        cost = getattr(turn, "cost_usd", None)
        if isinstance(cost, (int, float)):
            self.total_cost_usd += float(cost)
        input_tokens = getattr(turn, "input_tokens", None)
        if isinstance(input_tokens, (int, float)):
            self.total_input_tokens += int(input_tokens)
        output_tokens = getattr(turn, "output_tokens", None)
        if isinstance(output_tokens, (int, float)):
            self.total_output_tokens += int(output_tokens)
        return turn


def build_hermes_agent(
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    temperature: float = 0.0,
    reasoning_effort: str = "low",
    max_tokens: int | None = 4096,
) -> Callable[[list[MessageTurn], list[dict[str, Any]]], Awaitable[MessageTurn]]:
    """Build a Hermes-template agent callable for the bench runner.

    Returns an :class:`OpenAICompatAgent` whose ``__call__(history, tools)``
    matches the runner's ``AgentFn`` signature. Cost is tracked on the
    instance via ``total_cost_usd``; per-turn cost is also attached to each
    returned ``MessageTurn`` so the runner's existing ``getattr`` accounting
    works without any runner changes.

    LifeOps uses the source-loaded ``hermes-adapter`` harness so the
    benchmark path matches the other Hermes smoke adapters. The legacy
    OpenAI-compatible client still exists under ``clients/hermes.py`` for
    direct endpoint experiments, but it requires ``HERMES_BASE_URL`` and
    bypasses the source harness setup.
    """
    ensure_benchmark_adapter_importable("hermes")
    try:
        from hermes_adapter.client import HermesClient
        from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn
    except ImportError as exc:  # pragma: no cover - import-only branch
        raise SystemExit(
            "build_hermes_agent requires the hermes-adapter package "
            "(packages/benchmarks/hermes-adapter). Install it in the active env."
        ) from exc

    # Use in_process mode by default: the parent Python already has openai
    # installed (the bench depends on litellm/openai), so we can drive the
    # OpenAI-compatible Cerebras endpoint directly without requiring a
    # hermes-agent venv subprocess.
    client_kwargs: dict[str, Any] = {
        "mode": "in_process",
        "temperature": temperature,
        "reasoning_effort": reasoning_effort,
        "max_tokens": max_tokens,
    }
    if model:
        client_kwargs["model"] = model
    if base_url:
        client_kwargs["base_url"] = base_url
    if api_key:
        client_kwargs["api_key"] = api_key
    client = HermesClient(**client_kwargs)

    # Allow operators to override the system prompt with an optimized one
    # (e.g. the artifact produced by `bun run train --optimizer dspy-mipro`).
    # The override is read from disk so we don't bake training output into
    # source.
    import json as _json
    import os as _os

    # P2-6: include BLOCK kwarg shape hint so the model uses bundle_id
    # (e.g. 'com.apple.Safari') not app_name when emitting BLOCK actions.
    default_system_prompt = (
        "You are running LifeOpsBench. Use the supplied tools exactly "
        "when they are needed, and keep responses concise. "
        "For BLOCK actions, use bundle_id (e.g., 'com.apple.Safari') not app_name."
    )
    system_prompt = default_system_prompt
    override_path = _os.environ.get("LIFEOPS_PLANNER_PROMPT_FILE")
    if override_path and _os.path.exists(override_path):
        try:
            if override_path.endswith(".json"):
                with open(override_path, "r", encoding="utf-8") as fh:
                    obj = _json.load(fh)
                if isinstance(obj, dict) and isinstance(obj.get("prompt"), str):
                    system_prompt = obj["prompt"]
            else:
                with open(override_path, "r", encoding="utf-8") as fh:
                    text = fh.read().strip()
                if text:
                    system_prompt = text
        except OSError:
            pass

    inner = build_lifeops_bench_agent_fn(
        client=client,
        model_name=model,
        system_prompt=system_prompt,
    )
    return HermesLifeOpsAgent(inner)
