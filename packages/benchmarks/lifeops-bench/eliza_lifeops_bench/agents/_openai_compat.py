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
            msg["tool_calls"] = list(turn.tool_calls)
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

    Per-turn cost / latency / token telemetry is attached as extra attrs on
    the dataclass instance — the runner reads them via ``getattr`` with a
    default of 0.
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
    turn = MessageTurn(
        role="assistant",
        content=response.content or "",
        tool_calls=tool_calls if tool_calls else None,
    )
    # Telemetry the runner reads via getattr. Setting extra attrs on a
    # non-frozen dataclass is allowed; the runner expects these names.
    turn.cost_usd = float(response.cost_usd)  # type: ignore[attr-defined]
    turn.latency_ms = int(response.latency_ms)  # type: ignore[attr-defined]
    turn.input_tokens = int(response.usage.prompt_tokens)  # type: ignore[attr-defined]
    turn.output_tokens = int(response.usage.completion_tokens)  # type: ignore[attr-defined]
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
    ) -> None:
        self._client_factory = client_factory
        self._client: BaseClient | None = None
        self._temperature = temperature
        self._reasoning_effort = reasoning_effort
        self._max_tokens = max_tokens
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
        self.total_cost_usd += float(response.cost_usd)
        self.total_input_tokens += int(response.usage.prompt_tokens)
        self.total_output_tokens += int(response.usage.completion_tokens)
        return client_response_to_message_turn(response)
