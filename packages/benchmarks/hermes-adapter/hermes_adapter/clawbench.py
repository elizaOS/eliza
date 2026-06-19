"""ClawBench agent_fn factory backed by hermes-agent.

ClawBench drives a fixed scenario with a sequence of turns and tools defined
in a YAML manifest. The adapter spawns one hermes-agent invocation per turn
and returns the structured response shape ClawBench expects::

    {
        "text": str,
        "tool_calls": [{"id": str, "name": str, "arguments": str|dict}, ...],
        "thought": str | None,
        "usage": {"prompt_tokens": int, "completion_tokens": int},
        "model_name": str | None,
        "cost_usd": float | None,
    }
"""

from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable, Final

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


# Per-million-token USD pricing for Cerebras gpt-oss-120b. Mirrors the table
# in ``hermes_adapter.lifeops_bench`` so multi-harness ClawBench numbers are
# directly comparable.
_CEREBRAS_PRICING: Final[dict[str, dict[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def _compute_cost_usd(
    model: str | None, prompt_tokens: int, completion_tokens: int
) -> float | None:
    if not model:
        return None
    pricing = _CEREBRAS_PRICING.get(model)
    if pricing is None:
        return None
    return (
        (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    )


def build_clawbench_agent_fn(
    *,
    client: HermesClient | None = None,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any] | None = None,
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Build a ClawBench-compatible async agent_fn backed by hermes-agent.

    Args:
        client: Optional preconfigured :class:`HermesClient`.
        scenario_yaml: Parsed ClawBench scenario manifest. The adapter reads
            ``scenario_yaml.get("prompt")``, ``scenario_yaml.get("system_prompt")``,
            and (as a fallback) ``scenario_yaml.get("model_name")``.
        fixtures: Pre-attached fixture data inlined into the user message as
            ``BENCHMARK CONTEXT`` JSON so the model can read fixtures without
            a tool round-trip.
        model_name: Optional explicit model label (overrides
            ``scenario_yaml["model_name"]``) used for cost attribution.

    Returns:
        An async callable matching the ClawBench agent_fn contract.
    """
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)

    scenario_prompt = scenario_yaml.get("prompt") if isinstance(scenario_yaml, dict) else None
    if not isinstance(scenario_prompt, str):
        scenario_prompt = ""
    system_prompt = scenario_yaml.get("system_prompt") if isinstance(scenario_yaml, dict) else None
    if not isinstance(system_prompt, str):
        system_prompt = None
    if model_name is None:
        candidate = scenario_yaml.get("model_name") if isinstance(scenario_yaml, dict) else None
        if isinstance(candidate, str):
            model_name = candidate
    fixtures_dict: dict[str, Any] = dict(fixtures or {})

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        last_user_text = ""
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
                last_user_text = str(content or "")
                break

        # Compose scenario_prompt + fixtures + user_text into a single message
        # so hermes-agent sees the full ClawBench context in one turn.
        chunks: list[str] = []
        if scenario_prompt.strip():
            chunks.append(scenario_prompt.strip())
        if fixtures_dict:
            chunks.append(
                "BENCHMARK CONTEXT:\n"
                + json.dumps(fixtures_dict, ensure_ascii=True, indent=2)
            )
        if last_user_text.strip():
            chunks.append(last_user_text.strip())
        composed = "\n\n".join(chunk for chunk in chunks if chunk)
        if not composed:
            return {"text": "", "tool_calls": [], "thought": None}

        context: dict[str, object] = {}
        if tools:
            context["tools"] = tools
        if system_prompt:
            context["system_prompt"] = system_prompt

        try:
            resp = bridge.send_message(composed, context=context or None)
        except Exception as exc:
            logger.exception("[hermes-clawbench] send_message failed")
            raise RuntimeError("hermes ClawBench send_message failed") from exc

        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                args_raw = entry.get("arguments", "")
                if isinstance(args_raw, str) and args_raw.strip().startswith(("{", "[")):
                    try:
                        args_parsed: Any = json.loads(args_raw)
                    except (TypeError, ValueError):
                        args_parsed = args_raw
                else:
                    args_parsed = args_raw
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "name": name,
                        "arguments": args_parsed,
                    }
                )

        usage = resp.params.get("usage") if isinstance(resp.params, dict) else None
        if not isinstance(usage, dict):
            usage = {}
        prompt_tokens_raw = usage.get("prompt_tokens")
        completion_tokens_raw = usage.get("completion_tokens")
        prompt_tokens = int(prompt_tokens_raw) if isinstance(prompt_tokens_raw, (int, float)) else 0
        completion_tokens = (
            int(completion_tokens_raw)
            if isinstance(completion_tokens_raw, (int, float))
            else 0
        )

        pricing_model = model_name or bridge.model
        cost = _compute_cost_usd(pricing_model, prompt_tokens, completion_tokens)

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
        elif pricing_model:
            result["model_name"] = pricing_model
        if cost is not None:
            result["cost_usd"] = float(cost)
        return result

    return _agent_fn
