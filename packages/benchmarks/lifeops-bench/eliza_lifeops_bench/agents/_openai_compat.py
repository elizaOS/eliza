"""Shared scaffolding for agents backed by OpenAI-compatible chat clients.

The Hermes and Cerebras-direct adapters both consume :class:`BaseClient`
implementations whose ``complete(call)`` returns a uniform
:class:`ClientResponse`. The translation between the runner's
``MessageTurn`` history and the client's ``ClientCall`` is identical for
both backends — only the client class differs. This module factors out:

- ``message_turns_to_openai`` — convert ``list[MessageTurn]`` → OpenAI
  chat-completions ``messages`` shape.
- ``client_response_to_message_turn`` — convert ``ClientResponse`` →
  ``MessageTurn`` with ``cost_usd`` / ``latency_ms`` / token attrs attached
  for the runner's ``getattr`` accounting path.
- :class:`OpenAICompatAgent` — callable wrapper that lazily constructs its
  client, threads ``ClientCall`` defaults, accumulates ``total_cost_usd``,
  and exposes ``__call__(history, tools)``.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from ..clients.base import BaseClient, ClientCall, ClientResponse
from ..types import MessageTurn

# Factory signature: synchronous, no args, returns a constructed BaseClient.
# Lazy so the agent can be built without immediately requiring API keys etc.
ClientFactory = Callable[[], BaseClient]

LIFEOPS_TOOL_SYSTEM_PROMPT = (
    "You are running LifeOpsBench. When the user request requires changing or "
    "querying LifeOps state, call the supplied tool with structured arguments "
    "instead of describing the action in prose. Emit one clear tool call per "
    "action and wait for the tool result before finalizing."
)


def _json_arguments(raw_args: Any) -> str:
    """Return canonical JSON-object arguments for OpenAI tool_call history."""
    if isinstance(raw_args, str):
        if not raw_args:
            return "{}"
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError as exc:
            raise ValueError(f"tool_call arguments were not valid JSON: {raw_args!r}") from exc
        if not isinstance(parsed, dict):
            raise ValueError(
                f"tool_call arguments JSON must decode to an object, got {type(parsed).__name__}"
            )
        return json.dumps(parsed, sort_keys=True)
    if isinstance(raw_args, dict):
        return json.dumps(raw_args, sort_keys=True)
    if raw_args is None:
        return "{}"
    raise ValueError(f"tool_call arguments must be str or dict, got {type(raw_args).__name__}")


def _normalize_tool_calls_for_openai(
    tool_calls: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Normalize nested or flat tool calls into OpenAI chat-completions shape."""
    normalized: list[dict[str, Any]] = []
    for index, call in enumerate(tool_calls):
        if not isinstance(call, dict):
            continue
        function = call.get("function")
        if isinstance(function, dict):
            name = function.get("name")
            raw_args = function.get("arguments", {})
        else:
            name = call.get("name")
            raw_args = call.get("arguments", call.get("kwargs", {}))
        if not isinstance(name, str) or not name:
            raise ValueError(f"tool_call {index} missing function name")
        call_id = call.get("id")
        normalized.append(
            {
                "id": str(call_id) if call_id else f"call_{index}",
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": _json_arguments(raw_args),
                },
            }
        )
    return normalized


def message_turns_to_openai(history: list[MessageTurn]) -> list[dict[str, Any]]:
    """Convert the runner's ``MessageTurn`` history to OpenAI-format messages.

    Preserves ``tool_calls`` on assistant turns and ``tool_call_id`` on tool
    turns so the upstream client can re-format to whatever wire protocol its
    provider expects (Hermes XML, Anthropic blocks, native OpenAI, etc.).
    """
    out: list[dict[str, Any]] = []
    for turn in history:
        msg: dict[str, Any] = {"role": turn.role, "content": turn.content or ""}
        if turn.role == "assistant" and turn.tool_calls:
            msg["tool_calls"] = _normalize_tool_calls_for_openai(turn.tool_calls)
            if not msg["content"]:
                # OpenAI-compatible servers reject an empty string alongside
                # assistant tool_calls; the protocol expects null content.
                msg["content"] = None
        if turn.role == "tool":
            if turn.tool_call_id is not None:
                msg["tool_call_id"] = turn.tool_call_id
            if turn.name is not None:
                msg["name"] = turn.name
        out.append(msg)
    return out


def client_response_to_message_turn(response: ClientResponse) -> MessageTurn:
    """Convert a uniform ``ClientResponse`` to an assistant ``MessageTurn``.

    Tool calls are emitted in OpenAI-nested form
    (``{"id", "type": "function", "function": {"name", "arguments"}}``) so
    they round-trip cleanly through ``runner._extract_actions_from_turn``
    and ``runner._extract_tool_call_id``.

    Per-turn cost / latency / token telemetry lands on the ``MessageTurn``
    dataclass fields directly. ``cost_usd`` stays :data:`None` when the
    provider couldn't price the call (unknown model) — per AGENTS.md Cmd
    #8, no silent ``0.0`` fallback.
    """
    tool_calls: list[dict[str, Any]] = []
    for tc in response.tool_calls:
        tool_calls.append(
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": json.dumps(tc.arguments, sort_keys=True),
                },
            }
        )
    cost = (
        float(response.cost_usd) if response.cost_usd is not None else None
    )
    turn = MessageTurn(
        role="assistant",
        content=response.content or "",
        tool_calls=tool_calls if tool_calls else None,
        cost_usd=cost,
        latency_ms=float(response.latency_ms),
        input_tokens=int(response.usage.prompt_tokens),
        output_tokens=int(response.usage.completion_tokens),
    )
    setattr(turn, "cache_read_input_tokens", response.usage.cache_read_input_tokens)
    setattr(turn, "cache_creation_input_tokens", response.usage.cache_creation_input_tokens)
    setattr(turn, "cache_supported", True)
    return turn


class OpenAICompatAgent:
    """Callable agent that wraps any :class:`BaseClient`.

    The client is constructed lazily on the first call so the agent can be
    built in CLI ``argparse``-time without resolving API keys or HTTP
    transports. Per-instance ``total_cost_usd`` accumulates across all
    completions; tests and the runner can both read it.
    """

    def __init__(
        self,
        client_factory: ClientFactory,
        *,
        temperature: float = 0.0,
        reasoning_effort: str = "low",
        max_tokens: int | None = None,
        system_prompt: str | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._client: BaseClient | None = None
        self._temperature = temperature
        self._reasoning_effort = reasoning_effort
        self._max_tokens = max_tokens
        self._system_prompt = system_prompt or LIFEOPS_TOOL_SYSTEM_PROMPT
        self.total_cost_usd: float = 0.0
        self.total_input_tokens: int = 0
        self.total_output_tokens: int = 0

    @property
    def client(self) -> BaseClient:
        """Lazily-constructed inference client. Built on first access."""
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    async def __call__(
        self,
        history: list[MessageTurn],
        tools: list[dict[str, Any]],
    ) -> MessageTurn:
        messages = message_turns_to_openai(history)
        if tools and not any(msg.get("role") == "system" for msg in messages):
            messages.insert(0, {"role": "system", "content": self._system_prompt})
        call = ClientCall(
            messages=messages,
            tools=list(tools) if tools else None,
            temperature=self._temperature,
            reasoning_effort=self._reasoning_effort,  # type: ignore[arg-type]
            max_tokens=self._max_tokens,
        )
        # Do NOT swallow ProviderError or any other exception — the runner
        # has its own per-scenario error handling and needs to see the
        # actual failure.
        response = await self.client.complete(call)
        if response.cost_usd is not None:
            # Unpriced calls (model not in pricing table) skip the
            # accumulator so it tracks only billable spend — not a silent
            # ``+0`` that would conflate "free" with "unpriced".
            self.total_cost_usd += float(response.cost_usd)
        self.total_input_tokens += int(response.usage.prompt_tokens)
        self.total_output_tokens += int(response.usage.completion_tokens)
        return client_response_to_message_turn(response)
