"""Tau-bench agents that route the per-step chat-completion call through the
three benchmark harnesses: ``hermes``, ``openclaw``, ``eliza``.

Each agent matches :class:`BaseTauAgent`'s synchronous ``solve(env, task_index,
max_num_steps)`` signature and mirrors :class:`LiteLLMToolCallingAgent`'s
control flow exactly. The only difference is *how the model call is made*:

* :class:`HermesTauAgent` — calls Cerebras (or any OpenAI-compatible endpoint)
  via :class:`hermes_adapter.client.HermesClient` in ``in_process`` mode. No
  hermes-agent venv required.
* :class:`OpenClawTauAgent` — calls Cerebras via
  :class:`openclaw_adapter.client.OpenClawClient` with
  ``direct_openai_compatible=True``. No openclaw CLI subprocess.
* :class:`ElizaTauAgent` — calls the elizaOS TS bench server via
  :class:`eliza_adapter.client.ElizaClient`. The bench server forwards through
  the AgentRuntime planner so the harness's full plugin/action chain is
  exercised (much heavier than the direct-API options).

The legacy stand-alone tau-bench adapter modules under
``{eliza,hermes,openclaw}-adapter/`` import from a removed
``elizaos_tau_bench.executor`` + ``TauBenchTask`` types and are non-functional.
This module replaces them. The runner picks an agent via
``TauBenchConfig.agent_harness`` (set by ``--agent-harness`` on the CLI).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from elizaos_tau_bench.eliza_agent import AgentRunResult, BaseTauAgent
from elizaos_tau_bench.types import RESPOND_ACTION_NAME, Action
from elizaos_tau_bench.upstream.envs.base import Env

logger = logging.getLogger(__name__)


# Per-million-token USD pricing for Cerebras gpt-oss-120b. Mirrors
# ``hermes_adapter.lifeops_bench._CEREBRAS_PRICING`` so totals are comparable.
_CEREBRAS_PRICING: dict[str, dict[str, float]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def _cost_usd(model: str | None, prompt_tokens: int, completion_tokens: int) -> float:
    if not model:
        return 0.0
    pricing = _CEREBRAS_PRICING.get(model.rsplit("/", 1)[-1])
    if pricing is None:
        return 0.0
    return (
        (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    )


def _strip_cerebras_unsupported(message: dict[str, Any]) -> dict[str, Any]:
    """Cerebras emits ``reasoning_content`` + ``provider_specific_fields`` on
    assistant turns and then rejects them on the next request. Strip
    defensively before re-threading."""
    msg = dict(message)
    msg.pop("reasoning_content", None)
    msg.pop("provider_specific_fields", None)
    return msg


def _action_from_response(text: str, tool_calls: list[dict[str, Any]]) -> Action:
    """Map a harness-shaped response into an upstream tau-bench Action."""
    if tool_calls:
        tc = tool_calls[0]
        # Both hermes and openclaw normalize to ``{"id", "name", "arguments"}``
        # OR OpenAI-shape ``{"id", "function": {"name", "arguments"}}``.
        name = tc.get("name")
        if not name and isinstance(tc.get("function"), dict):
            name = tc["function"].get("name")
        args_raw: Any = tc.get("arguments")
        if not args_raw and isinstance(tc.get("function"), dict):
            args_raw = tc["function"].get("arguments")
        if isinstance(args_raw, str):
            try:
                args = json.loads(args_raw or "{}")
            except json.JSONDecodeError:
                args = {}
        elif isinstance(args_raw, dict):
            args = args_raw
        else:
            args = {}
        if name:
            return Action(name=str(name), kwargs=args)
    return Action(name=RESPOND_ACTION_NAME, kwargs={"content": text or ""})


def _openai_tool_call_record(tc: dict[str, Any]) -> dict[str, Any]:
    """Build an OpenAI-shape assistant tool_call for the history thread."""
    name = tc.get("name") or (
        tc["function"].get("name") if isinstance(tc.get("function"), dict) else ""
    )
    args = tc.get("arguments")
    if args is None and isinstance(tc.get("function"), dict):
        args = tc["function"].get("arguments")
    if isinstance(args, dict):
        args_str = json.dumps(args)
    elif isinstance(args, str):
        args_str = args
    else:
        args_str = "{}"
    return {
        "id": str(tc.get("id") or "call_0"),
        "type": "function",
        "function": {"name": str(name or ""), "arguments": args_str},
    }


class _HarnessTauAgentBase(BaseTauAgent):
    """Shared tau-bench solve loop. Subclasses provide :meth:`_chat_step`."""

    def __init__(self, model: str = "gpt-oss-120b", temperature: float = 0.0) -> None:
        self.model = model
        self.temperature = temperature

    # Subclass hook
    def _chat_step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> tuple[str, list[dict[str, Any]], dict[str, int]]:
        """Returns (assistant_text, tool_calls, usage{prompt_tokens, completion_tokens})."""
        raise NotImplementedError

    def solve(
        self,
        env: Env,
        task_index: int,
        max_num_steps: int = 30,
    ) -> AgentRunResult:
        reset = env.reset(task_index=task_index)
        info: dict[str, Any] = reset.info.model_dump()
        reward = 0.0
        total_cost = 0.0
        num_tool_calls = 0
        actions_taken: list[Action] = []

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": env.wiki},
            {"role": "user", "content": reset.observation},
        ]

        try:
            for _step in range(max_num_steps):
                text, tool_calls, usage = self._chat_step(messages, env.tools_info)
                total_cost += _cost_usd(
                    self.model,
                    int(usage.get("prompt_tokens") or 0),
                    int(usage.get("completion_tokens") or 0),
                )

                action = _action_from_response(text, tool_calls)
                actions_taken.append(action)

                env_response = env.step(action)
                reward = env_response.reward
                info = {**info, **env_response.info.model_dump()}

                if action.name != RESPOND_ACTION_NAME:
                    num_tool_calls += 1
                    if tool_calls:
                        oai_tc = _openai_tool_call_record(tool_calls[0])
                        messages.append(
                            _strip_cerebras_unsupported(
                                {
                                    "role": "assistant",
                                    "content": text or None,
                                    "tool_calls": [oai_tc],
                                }
                            )
                        )
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": oai_tc["id"],
                                "name": oai_tc["function"]["name"],
                                "content": env_response.observation,
                            }
                        )
                    else:
                        messages.append(
                            _strip_cerebras_unsupported(
                                {"role": "assistant", "content": text or ""}
                            )
                        )
                else:
                    messages.append(
                        _strip_cerebras_unsupported(
                            {"role": "assistant", "content": text or ""}
                        )
                    )
                    messages.append(
                        {"role": "user", "content": env_response.observation}
                    )

                if env_response.done:
                    break
        except Exception as exc:
            logger.exception("Harness tau-agent solve loop failed: %s", exc)
            return AgentRunResult(
                reward=reward,
                messages=messages,
                info=info,
                actions_taken=actions_taken,
                num_tool_calls=num_tool_calls,
                num_turns=len(messages),
                agent_cost=total_cost,
                error=str(exc),
            )

        return AgentRunResult(
            reward=reward,
            messages=messages,
            info=info,
            actions_taken=actions_taken,
            num_tool_calls=num_tool_calls,
            num_turns=len(messages),
            agent_cost=total_cost,
        )


class HermesTauAgent(_HarnessTauAgentBase):
    """Route each tau-bench step through :class:`HermesClient` in_process mode."""

    def __init__(self, model: str = "gpt-oss-120b", temperature: float = 0.0) -> None:
        super().__init__(model=model, temperature=temperature)
        import importlib.util

        from hermes_adapter.client import HermesClient

        mode_env = os.environ.get("HERMES_ADAPTER_MODE", "").strip()
        if mode_env in {"in_process", "subprocess"}:
            mode = mode_env
        else:
            mode = (
                "in_process"
                if importlib.util.find_spec("openai")
                else "subprocess"
            )
        self._client = HermesClient(
            provider="cerebras",
            model=model,
            mode=mode,
            temperature=temperature,
            max_tokens=4096,
        )

    def _chat_step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> tuple[str, list[dict[str, Any]], dict[str, int]]:
        cleaned = [_strip_cerebras_unsupported(m) for m in messages]
        last_user = next(
            (m.get("content") or "" for m in reversed(cleaned) if m.get("role") == "user"),
            "",
        )
        context: dict[str, Any] = {"messages": cleaned}
        if tools:
            context["tools"] = tools
            context["tool_choice"] = "auto"
        resp = self._client.send_message(str(last_user), context=context)
        params = resp.params if isinstance(resp.params, dict) else {}
        tool_calls = params.get("tool_calls") or []
        if not isinstance(tool_calls, list):
            tool_calls = []
        usage = params.get("usage") if isinstance(params.get("usage"), dict) else {}
        return resp.text or "", list(tool_calls), {
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
        }


class OpenClawTauAgent(_HarnessTauAgentBase):
    """Route each tau-bench step through :class:`OpenClawClient` direct mode."""

    def __init__(self, model: str = "gpt-oss-120b", temperature: float = 0.0) -> None:
        super().__init__(model=model, temperature=temperature)
        from openclaw_adapter.client import OpenClawClient

        self._client = OpenClawClient(
            provider="cerebras",
            model=model,
            direct_openai_compatible=True,
            temperature=temperature,
            max_tokens=4096,
        )

    def _chat_step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> tuple[str, list[dict[str, Any]], dict[str, int]]:
        cleaned = [_strip_cerebras_unsupported(m) for m in messages]
        last_user = next(
            (m.get("content") or "" for m in reversed(cleaned) if m.get("role") == "user"),
            "",
        )
        context: dict[str, Any] = {"messages": cleaned}
        if tools:
            context["tools"] = tools
            context["tool_choice"] = "auto"
        resp = self._client.send_message(str(last_user), context=context)
        params = resp.params if isinstance(resp.params, dict) else {}
        tool_calls = params.get("tool_calls") or []
        if not isinstance(tool_calls, list):
            tool_calls = []
        usage = params.get("usage") if isinstance(params.get("usage"), dict) else {}
        if not usage:
            # CLI mode buries usage under params['_meta']['usage']
            meta = params.get("_meta")
            if isinstance(meta, dict) and isinstance(meta.get("usage"), dict):
                usage = meta["usage"]
        return resp.text or "", list(tool_calls), {
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
        }


class ElizaTauAgent(_HarnessTauAgentBase):
    """Route each tau-bench step through the elizaOS TS bench server.

    Spawns :class:`ElizaServerManager` on first use when ``ELIZA_BENCH_URL``
    is not set. The bench server forwards to the AgentRuntime planner which
    eventually calls plugin-openai → Cerebras. This adds significant
    per-step overhead vs. the direct hermes/openclaw paths and is the
    correct way to attribute scores to the elizaOS stack as a whole.
    """

    def __init__(self, model: str = "gpt-oss-120b", temperature: float = 0.0) -> None:
        super().__init__(model=model, temperature=temperature)
        from eliza_adapter.client import ElizaClient

        self._server_manager = None
        if not os.environ.get("ELIZA_BENCH_URL"):
            from eliza_adapter.server_manager import ElizaServerManager

            self._server_manager = ElizaServerManager()
            self._server_manager.start()
            self._client = self._server_manager.client
        else:
            self._client = ElizaClient()
        self._client.wait_until_ready(timeout=180)
        try:
            self._client.reset(task_id="tau_bench", benchmark="tau_bench")
        except Exception:  # noqa: BLE001 — reset is best-effort
            pass

    def _chat_step(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> tuple[str, list[dict[str, Any]], dict[str, int]]:
        cleaned = [_strip_cerebras_unsupported(m) for m in messages]
        last_user = next(
            (m.get("content") or "" for m in reversed(cleaned) if m.get("role") == "user"),
            "",
        )
        context: dict[str, Any] = {
            "messages": cleaned,
            "benchmark": "tau_bench",
            "task_id": "tau_bench",
        }
        if tools:
            context["tools"] = tools
            context["tool_choice"] = "auto"
        resp = self._client.send_message(str(last_user), context=context)
        params = resp.params if isinstance(resp.params, dict) else {}
        tool_calls = params.get("tool_calls") or []
        if not isinstance(tool_calls, list):
            tool_calls = []
        usage = params.get("usage") if isinstance(params.get("usage"), dict) else {}
        return resp.text or "", list(tool_calls), {
            "prompt_tokens": int(
                usage.get("prompt_tokens") or usage.get("promptTokens") or 0
            ),
            "completion_tokens": int(
                usage.get("completion_tokens") or usage.get("completionTokens") or 0
            ),
        }


__all__ = [
    "HermesTauAgent",
    "OpenClawTauAgent",
    "ElizaTauAgent",
]
