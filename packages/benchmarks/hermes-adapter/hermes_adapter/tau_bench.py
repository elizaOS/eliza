"""Tau-bench agent backed by hermes-agent.

Drop-in equivalent of :class:`elizaos_tau_bench.eliza_agent.LiteLLMToolCallingAgent`
but routes the agent-side completion through :class:`HermesClient`.

The control flow mirrors ``LiteLLMToolCallingAgent.solve`` exactly — same
upstream ``Env`` reset / step loop, same message-building, same
``_message_to_action`` semantics — so reward computation stays identical to
the litellm path. The only difference is *how* the per-turn completion is
produced: ``HermesClient`` is used in ``in_process`` mode (auto-detected when
``openai`` is importable in the parent venv) so we hit the Cerebras
OpenAI-compatible endpoint directly without spawning the hermes-agent venv.

Cerebras quirk: ``gpt-oss-120b`` returns a ``reasoning_content`` field on
assistant turns, then rejects subsequent requests that include that field
on prior assistant messages. We strip ``reasoning_content`` and
``provider_specific_fields`` from assistant messages before feeding them
back into the next call.
"""

from __future__ import annotations

import importlib.util
import json
import logging
from typing import Any, Final

from hermes_adapter.client import HermesClient, MessageResponse

from elizaos_tau_bench.eliza_agent import AgentRunResult, BaseTauAgent
from elizaos_tau_bench.types import Action, RESPOND_ACTION_NAME
from elizaos_tau_bench.upstream.envs.base import Env

logger = logging.getLogger(__name__)


# Per-million-token USD pricing for Cerebras gpt-oss-120b. Mirrors the
# ``_CEREBRAS_PRICING`` constant in ``hermes_adapter.lifeops_bench`` so
# tau-bench's per-trial ``agent_cost`` is consistent with lifeops-bench
# numbers when both hit the same provider.
_CEREBRAS_PRICING: Final[dict[str, dict[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def _compute_cost_usd(
    model: str | None, prompt_tokens: int, completion_tokens: int
) -> float:
    """Return USD cost for a Cerebras completion or ``0.0`` when unpriced."""
    if not model:
        return 0.0
    bare = model.rsplit("/", 1)[-1]
    pricing = _CEREBRAS_PRICING.get(bare)
    if pricing is None:
        return 0.0
    return (
        (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    )


def _strip_cerebras_quirks(message: dict[str, Any]) -> dict[str, Any]:
    """Strip fields Cerebras emits but rejects on re-submission.

    ``reasoning_content`` and ``provider_specific_fields`` are returned on
    assistant turns by gpt-oss-120b but cause ``BadRequestError:
    messages.X.assistant.reasoning_content: property unsupported`` if echoed
    back in the conversation history.
    """
    for key in ("reasoning_content", "provider_specific_fields"):
        message.pop(key, None)
    return message


def _detect_in_process_default() -> bool:
    """Pick ``in_process`` if ``openai`` is importable in the parent venv."""
    return importlib.util.find_spec("openai") is not None


def _message_to_action(message: dict[str, Any]) -> Action:
    """Convert an OpenAI-shape assistant message into an upstream ``Action``."""
    tool_calls = message.get("tool_calls")
    if tool_calls and len(tool_calls) > 0:
        tc = tool_calls[0]
        if isinstance(tc, dict):
            fn = tc.get("function") or {}
            name = fn.get("name") or ""
            args_raw = fn.get("arguments")
        else:
            fn = getattr(tc, "function", None)
            name = getattr(fn, "name", "") if fn is not None else ""
            args_raw = getattr(fn, "arguments", "") if fn is not None else ""
        if isinstance(args_raw, str):
            try:
                kwargs = json.loads(args_raw or "{}")
            except json.JSONDecodeError:
                kwargs = {}
        elif isinstance(args_raw, dict):
            kwargs = dict(args_raw)
        else:
            kwargs = {}
        if name:
            return Action(name=str(name), kwargs=kwargs)
    return Action(
        name=RESPOND_ACTION_NAME,
        kwargs={"content": message.get("content") or ""},
    )


def _normalize_tool_calls_for_history(
    raw_tool_calls: list[Any] | None,
) -> list[dict[str, Any]]:
    """Return OpenAI chat-completions-shape tool_calls for the message history.

    HermesClient surfaces tool calls in a flat ``{id, name, arguments}`` shape;
    upstream's user simulator (and our env.step parser) expect the OpenAI
    nested ``{id, type, function: {name, arguments}}`` shape. Convert here so
    the message history is consistent.
    """
    if not raw_tool_calls:
        return []
    out: list[dict[str, Any]] = []
    for tc in raw_tool_calls:
        if isinstance(tc, dict):
            if "function" in tc and isinstance(tc["function"], dict):
                fn = tc["function"]
                fn_name = fn.get("name") or ""
                fn_args = fn.get("arguments")
            else:
                fn_name = tc.get("name") or ""
                fn_args = tc.get("arguments")
            tc_id = tc.get("id") or f"call_{len(out)}"
        else:
            continue
        if not fn_name:
            continue
        if isinstance(fn_args, dict):
            args_str = json.dumps(fn_args)
        elif isinstance(fn_args, str):
            args_str = fn_args or "{}"
        else:
            args_str = "{}"
        out.append(
            {
                "id": str(tc_id),
                "type": "function",
                "function": {"name": fn_name, "arguments": args_str},
            }
        )
    return out


class HermesTauAgent(BaseTauAgent):
    """Tau-bench agent that drives an upstream ``Env`` via hermes-agent.

    Mirrors :class:`LiteLLMToolCallingAgent.solve` step-for-step; only the
    chat-completions call is replaced.
    """

    def __init__(
        self,
        model: str = "gpt-oss-120b",
        provider: str = "cerebras",
        temperature: float = 0.0,
        client: HermesClient | None = None,
        mode: str | None = None,
    ) -> None:
        self.model = model
        self.provider = provider
        self.temperature = temperature
        if client is not None:
            self.client = client
        else:
            chosen_mode = mode
            if chosen_mode is None:
                chosen_mode = "in_process" if _detect_in_process_default() else "subprocess"
            self.client = HermesClient(
                provider=provider,
                model=model,
                mode=chosen_mode,
                temperature=temperature,
            )

    # ------------------------------------------------------------------
    # BaseTauAgent
    # ------------------------------------------------------------------

    def solve(self, env: Env, task_index: int, max_num_steps: int = 30) -> AgentRunResult:
        reset = env.reset(task_index=task_index)
        obs = reset.observation
        info: dict[str, Any] = reset.info.model_dump()
        reward = 0.0
        total_cost = 0.0
        num_tool_calls = 0
        actions_taken: list[Action] = []

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": env.wiki},
            {"role": "user", "content": obs},
        ]
        tools_info = list(env.tools_info)

        try:
            for _step_i in range(max_num_steps):
                response = self._one_turn(messages, tools_info)
                next_message = self._response_to_assistant_message(response)
                _strip_cerebras_quirks(next_message)

                # Token accounting
                usage = response.params.get("usage") if isinstance(response.params, dict) else None
                if isinstance(usage, dict):
                    prompt_tokens = int(usage.get("prompt_tokens") or usage.get("promptTokens") or 0)
                    completion_tokens = int(
                        usage.get("completion_tokens") or usage.get("completionTokens") or 0
                    )
                    total_cost += _compute_cost_usd(self.model, prompt_tokens, completion_tokens)

                action = _message_to_action(next_message)
                actions_taken.append(action)

                env_response = env.step(action)
                reward = env_response.reward
                info = {**info, **env_response.info.model_dump()}

                if action.name != RESPOND_ACTION_NAME:
                    num_tool_calls += 1
                    tcs = next_message.get("tool_calls") or []
                    if tcs:
                        # Trim to single tool call per upstream parity
                        next_message["tool_calls"] = tcs[:1]
                        tc = next_message["tool_calls"][0]
                        messages.extend(
                            [
                                next_message,
                                {
                                    "role": "tool",
                                    "tool_call_id": tc["id"],
                                    "name": tc["function"]["name"],
                                    "content": env_response.observation,
                                },
                            ]
                        )
                    else:
                        # Recovered text tool call had no structured calls;
                        # treat as plain assistant turn so the env can still
                        # advance via the user simulator.
                        messages.append(next_message)
                        messages.append(
                            {"role": "user", "content": env_response.observation}
                        )
                else:
                    messages.extend(
                        [
                            next_message,
                            {"role": "user", "content": env_response.observation},
                        ]
                    )

                if env_response.done:
                    break
        except Exception as e:
            logger.exception("[hermes-tau] solve loop failed: %s", e)
            return AgentRunResult(
                reward=reward,
                messages=messages,
                info=info,
                actions_taken=actions_taken,
                num_tool_calls=num_tool_calls,
                num_turns=len(messages),
                agent_cost=total_cost,
                error=str(e),
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

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _one_turn(
        self,
        messages: list[dict[str, Any]],
        tools_info: list[dict[str, Any]],
    ) -> MessageResponse:
        """Send one chat-completions request via the hermes bridge."""
        # We bypass HermesClient's prompt-flattening by passing the full
        # message list under context["messages"]. The empty ``text`` here is
        # only used as a fallback by subprocess mode.
        context: dict[str, object] = {
            "messages": _scrub_history_for_cerebras(messages),
        }
        if tools_info:
            context["tools"] = tools_info
            context["tool_choice"] = "auto"
        if self.temperature is not None:
            context["temperature"] = float(self.temperature)
        # Use the last user-ish text as a bare fallback prompt.
        last_user = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last_user = str(m.get("content") or "")
                break
        return self.client.send_message(last_user, context=context)

    @staticmethod
    def _response_to_assistant_message(response: MessageResponse) -> dict[str, Any]:
        """Build an OpenAI chat-completions-shape assistant message."""
        tool_calls = _normalize_tool_calls_for_history(
            response.params.get("tool_calls") if isinstance(response.params, dict) else None
        )
        msg: dict[str, Any] = {
            "role": "assistant",
            "content": response.text or "",
        }
        if tool_calls:
            msg["tool_calls"] = tool_calls
            if not msg["content"]:
                msg["content"] = None
        return msg


def _scrub_history_for_cerebras(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop Cerebras-only fields from prior assistant turns before resending.

    Returns a shallow copy with ``reasoning_content`` /
    ``provider_specific_fields`` removed from every assistant message.
    """
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.get("role") == "assistant":
            scrubbed = dict(m)
            scrubbed.pop("reasoning_content", None)
            scrubbed.pop("provider_specific_fields", None)
            out.append(scrubbed)
        else:
            out.append(m)
    return out


__all__ = ["HermesTauAgent"]
