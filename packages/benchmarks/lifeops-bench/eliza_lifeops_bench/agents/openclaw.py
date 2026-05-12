"""OpenClaw adapter for LifeOpsBench.

Drives an LLM through the OpenClaw text-embedded tool-call format used by
the vendored OpenClaw runner at
``packages/benchmarks/openclaw-benchmark/openclaw/runner.py`` (the
intended ``https://github.com/elizaOS/openclaw-adapter`` repository
returns 404; the vendored copy is the fallback).

Approach (A): we wrap an underlying OpenAI-compatible chat client
(:class:`CerebrasClient` by default) and translate between the runner's
``MessageTurn`` history and OpenClaw's wire conventions:

- **Outbound system prompt** lists the available LifeOpsBench tools and
  their JSON-Schema parameters in the OpenClaw ``<tool_call>{"tool":
  "<name>", "args": {...}}</tool_call>`` format. This mirrors the
  upstream prompt at ``runner.py::BenchmarkRunner._build_system_prompt``
  with the tool catalogue substituted in for the upstream's hardcoded
  ``exec`` / ``write`` / ``read`` triplet.
- **Outbound history** strips assistant ``tool_calls`` back into
  ``<tool_call>{...}</tool_call>`` text (so the model sees its own prior
  calls in the format it's instructed to emit), and folds tool-role
  messages into a ``Tool results:\\n[<tool>]: <json>`` user message
  (mirroring ``runner.py:255-257``).
- **Inbound parsing** runs the same regex
  (``re.compile(r"<tool_call>\\s*(\\{.*?\\})\\s*</tool_call>", re.DOTALL)``)
  used upstream and translates each ``{"tool": ..., "args": ...}`` block
  into the OpenAI-nested tool_call shape the runner already understands
  (``{id, type: "function", function: {name, arguments}}``).

Approach B (calling ``BenchmarkRunner.run_scenario`` directly) was
rejected: the vendored class owns its own scenarios, sandbox, scoring,
and HTTP transport. The LifeOpsBench runner needs a per-turn
``(history, tools) -> MessageTurn`` callable, not a full scenario
runner. There is no way to extract the tool-format-and-prompt convention
from the vendored ``BenchmarkRunner`` without re-implementing the
translation at the boundary anyway, so we do exactly that here.

Cost / latency telemetry is attached to each returned ``MessageTurn``
(``cost_usd``, ``latency_ms``, ``input_tokens``, ``output_tokens``) and
accumulated on the agent instance via ``total_cost_usd`` /
``total_input_tokens`` / ``total_output_tokens`` — the same convention
the sibling Hermes / Cerebras-direct adapters use.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Final

from ..clients.base import BaseClient, ClientCall, ProviderError
from ..clients.cerebras import CerebrasClient
from ..types import MessageTurn

# Same regex the vendored runner uses (runner.py:128). Single source of
# truth for parsing well-formed OpenClaw tool_call blocks. A separate
# brace-balanced fallback below recovers blocks where the model omitted
# the closing ``</tool_call>`` (the gpt-oss-120b OpenClaw configuration
# emits this pattern on roughly 1-in-8 turns).
_TOOL_CALL_RE: Final[re.Pattern[str]] = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL
)
_TOOL_CALL_OPENER_RE: Final[re.Pattern[str]] = re.compile(
    r"<tool_call>\s*(\{)", re.DOTALL
)


def _build_system_prompt(tools: list[dict[str, Any]]) -> str:
    """Build an OpenClaw-format system prompt for the given tool catalogue.

    Mirrors the structure of the upstream ``runner.py::_build_system_prompt``
    (rules + format examples) but substitutes the LifeOpsBench tool
    manifest for the upstream's hardcoded ``exec`` / ``write`` / ``read``
    triplet. The tool catalogue is rendered as ``- <name>: <description>``
    + a JSON schema block per tool.
    """
    if not tools:
        tool_section = "(no tools available — respond with a final summary only)"
    else:
        lines: list[str] = []
        for tool in tools:
            fn = tool.get("function") or {}
            name = fn.get("name") or tool.get("name") or "<unnamed>"
            description = fn.get("description") or tool.get("description") or ""
            parameters = fn.get("parameters") or tool.get("parameters") or {}
            lines.append(f"- {name}: {description}")
            lines.append(
                f"  <tool_call>{{\"tool\": \"{name}\", \"args\": {json.dumps(parameters, sort_keys=True)}}}</tool_call>"
            )
        tool_section = "\n".join(lines)

    return (
        "You are a life-assistant agent operating through OpenClaw's "
        "text-embedded tool-call protocol.\n"
        "\n"
        "You MUST take action by emitting tool calls. Describing what you "
        "\"will do\" without emitting <tool_call> blocks counts as zero "
        "work and the task will fail.\n"
        "\n"
        "AVAILABLE TOOLS:\n"
        f"{tool_section}\n"
        "\n"
        "RULES:\n"
        "1. Every turn must contain at least one <tool_call> block until "
        "the task is fully done.\n"
        "2. Emit tool calls as raw text in your response, exactly like:\n"
        "   <tool_call>{\"tool\": \"<tool-name>\", \"args\": {...}}</tool_call>\n"
        "   One JSON object per <tool_call>...</tool_call> block. Multiple "
        "blocks per turn are allowed.\n"
        "3. Do NOT wrap tool calls in markdown fences. Do NOT use any "
        "other tag name. Do NOT use the OpenAI native tool_calls field — "
        "this protocol is text-embedded only.\n"
        "4. The args object must satisfy the tool's JSON schema shown "
        "above; pass values, not the schema itself.\n"
        "5. After the executor returns results (delivered as a user "
        "message starting with \"Tool results:\\n\"), reason about what "
        "to do next and emit more tool calls or a final summary.\n"
        "6. Only emit a final summary (no tool calls) once every "
        "requirement is satisfied.\n"
    )


def _format_assistant_for_openclaw(turn: MessageTurn) -> str:
    """Serialise an assistant turn back into OpenClaw text format.

    The runner stores assistant turns with ``tool_calls`` in OpenAI-nested
    shape; on the way back to the model we render those as
    ``<tool_call>{"tool": ..., "args": ...}</tool_call>`` so the model
    sees its own prior turns in the format it's being asked to emit.
    """
    parts: list[str] = []
    if turn.content:
        parts.append(turn.content)
    if turn.tool_calls:
        for tc in turn.tool_calls:
            fn = tc.get("function") or {}
            name = fn.get("name") or tc.get("name") or ""
            raw_args = fn.get("arguments")
            if raw_args is None:
                raw_args = tc.get("arguments")
            if isinstance(raw_args, str):
                args_obj = json.loads(raw_args) if raw_args else {}
            elif isinstance(raw_args, dict):
                args_obj = raw_args
            else:
                args_obj = {}
            parts.append(
                "<tool_call>"
                + json.dumps({"tool": name, "args": args_obj}, sort_keys=True)
                + "</tool_call>"
            )
    return "\n".join(parts) if parts else ""


def message_turns_to_openclaw(history: list[MessageTurn]) -> list[dict[str, Any]]:
    """Convert ``MessageTurn`` history to OpenClaw-style chat messages.

    Behaviour:
    - ``user`` and ``system`` turns pass through verbatim.
    - ``assistant`` turns get their ``tool_calls`` rendered back into
      ``<tool_call>{...}</tool_call>`` text so the protocol round-trips.
    - Consecutive ``tool`` turns are folded into a single ``user``
      message of shape ``Tool results:\\n[<tool>]: <json>\\n[<tool>]:
      <json>\\n``, mirroring ``runner.py:255-257``. This preserves call
      ordering while keeping the wire-format text-only (the OpenClaw
      protocol has no first-class tool role).
    """
    out: list[dict[str, Any]] = []
    pending_tool_results: list[tuple[str, str]] = []

    def flush_tool_results() -> None:
        if not pending_tool_results:
            return
        body_lines = ["Tool results:"]
        for tool_name, content in pending_tool_results:
            body_lines.append(f"[{tool_name}]: {content}")
        out.append({"role": "user", "content": "\n".join(body_lines)})
        pending_tool_results.clear()

    for turn in history:
        if turn.role == "tool":
            tool_name = turn.name or "unknown"
            pending_tool_results.append((tool_name, turn.content or ""))
            continue
        flush_tool_results()
        if turn.role == "assistant":
            content = _format_assistant_for_openclaw(turn)
            out.append({"role": "assistant", "content": content})
        else:
            out.append({"role": turn.role, "content": turn.content or ""})

    flush_tool_results()
    return out


def _brace_balanced_json_slice(text: str, start: int) -> tuple[str, int] | None:
    """Extract the top-level JSON object starting at ``text[start] == '{'``.

    Walks forward respecting string boundaries and ``\\`` escapes inside
    strings. Returns ``(json_slice, end_index)`` (``end_index`` is the
    index *after* the closing ``}``) once depth returns to zero, or
    ``None`` if the object never closes.
    """
    if start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1], i + 1
    return None


def _tool_call_block_to_openai_shape(
    raw_json: str, index: int
) -> dict[str, Any]:
    """Validate a JSON-encoded tool_call body and translate it into the
    OpenAI-nested shape the runner consumes.

    Raises ``ValueError`` on malformed JSON, missing ``tool`` key, or
    non-object ``args`` — the bench treats malformed tool output as a real
    failure (see AGENTS.md: do not hide uncertainty).
    """
    try:
        block = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"OpenClaw <tool_call> block {index} is not valid JSON: "
            f"{exc.msg}; raw={raw_json!r}"
        ) from exc
    name = block.get("tool")
    if not isinstance(name, str) or not name:
        raise ValueError(
            f"OpenClaw <tool_call> block {index} missing string 'tool' "
            f"key; raw={block!r}"
        )
    args = block.get("args", {})
    if not isinstance(args, dict):
        raise ValueError(
            f"OpenClaw <tool_call> block {index} 'args' must be a JSON "
            f"object; got {type(args).__name__}"
        )
    return {
        "id": f"call_openclaw_{index}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(args, sort_keys=True),
        },
    }


def parse_openclaw_tool_calls(text: str) -> tuple[str, list[dict[str, Any]]]:
    """Parse OpenClaw ``<tool_call>`` blocks out of an assistant response.

    Returns ``(prose_remainder, tool_calls)`` where ``tool_calls`` is in
    the OpenAI-nested shape the runner consumes
    (``{id, type: "function", function: {name, arguments}}``).

    Two passes:

    1. Well-formed blocks bounded by ``<tool_call>...</tool_call>``.
    2. If pass 1 found nothing and the text contains an opener, run a
       brace-balanced fallback over each ``<tool_call>{`` occurrence to
       recover unclosed blocks. The model occasionally emits an opening
       tag and a JSON body followed by trailing prose, never closing the
       tag — without this fallback the whole tool_call is silently
       dropped and the scenario scores zero.

    Malformed JSON inside a ``<tool_call>`` block raises ``ValueError``
    rather than being silently dropped — the bench treats malformed tool
    output as a real failure (see AGENTS.md: do not hide uncertainty).
    Pass 2 is exempted: an opener whose body fails to brace-balance is
    treated as "no tool call here" rather than a hard failure, because
    the alternative is to surface every truncated stream as an exception.
    """
    tool_calls: list[dict[str, Any]] = []
    matches = list(_TOOL_CALL_RE.finditer(text))
    for index, match in enumerate(matches):
        tool_calls.append(_tool_call_block_to_openai_shape(match.group(1), index))

    if tool_calls:
        prose = _TOOL_CALL_RE.sub("", text).strip()
        return prose, tool_calls

    # Pass 2: brace-balanced fallback for unclosed openers.
    # Track recovered span ends so we can strip them from prose too.
    recovered_spans: list[tuple[int, int]] = []
    for match in _TOOL_CALL_OPENER_RE.finditer(text):
        json_start = match.start(1)
        sliced = _brace_balanced_json_slice(text, json_start)
        if sliced is None:
            continue
        raw_json, end = sliced
        tool_calls.append(
            _tool_call_block_to_openai_shape(raw_json, len(tool_calls))
        )
        recovered_spans.append((match.start(), end))

    if recovered_spans:
        parts: list[str] = []
        cursor = 0
        for span_start, span_end in recovered_spans:
            parts.append(text[cursor:span_start])
            cursor = span_end
        parts.append(text[cursor:])
        prose = "".join(parts).strip()
    else:
        prose = text.strip()
    return prose, tool_calls


class OpenClawAgent:
    """Callable agent that drives any :class:`BaseClient` through the
    OpenClaw text-embedded tool-call protocol.

    The underlying client is constructed lazily on first call so the
    agent can be built without immediately requiring API keys. Per-call
    cost / latency / token telemetry is attached to each returned
    ``MessageTurn`` (``cost_usd``, ``latency_ms``, ``input_tokens``,
    ``output_tokens``) and accumulated on the instance via
    ``total_cost_usd`` / ``total_input_tokens`` /
    ``total_output_tokens``.
    """

    def __init__(
        self,
        client_factory: "ClientFactory",
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
        system_prompt = _build_system_prompt(list(tools) if tools else [])
        translated = message_turns_to_openclaw(history)
        # Always lead with our OpenClaw system prompt; if the history
        # already started with a system turn it is folded after ours so
        # both sets of instructions are present (ours first, since the
        # protocol contract takes precedence over scenario framing).
        if translated and translated[0]["role"] == "system":
            scenario_system = translated[0]["content"]
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt + "\n\n" + scenario_system},
                *translated[1:],
            ]
        else:
            messages = [{"role": "system", "content": system_prompt}, *translated]

        call = ClientCall(
            messages=messages,
            tools=None,  # Protocol is text-embedded; do NOT send native tools.
            temperature=self._temperature,
            reasoning_effort=self._reasoning_effort,  # type: ignore[arg-type]
            max_tokens=self._max_tokens,
        )
        start_ns = time.perf_counter_ns()
        response = await self.client.complete(call)
        # Latency is sourced from the client response (which times the
        # network round-trip); fall back to local wall-clock if absent.
        latency_ms = response.latency_ms or (time.perf_counter_ns() - start_ns) // 1_000_000

        text = response.content or ""
        prose, tool_calls = parse_openclaw_tool_calls(text)

        # If the upstream ALSO returned native tool_calls, surface that as
        # a ProviderError — the OpenClaw protocol is text-embedded only,
        # mixing both would break the contract and silently double-count.
        if response.tool_calls:
            raise ProviderError(
                "OpenClaw protocol: model emitted native tool_calls in "
                "addition to <tool_call> text blocks; this adapter "
                "expects text-embedded only.",
                status=None,
                body=json.dumps([tc.name for tc in response.tool_calls]),
                provider="openclaw",
            )

        cost = (
            float(response.cost_usd) if response.cost_usd is not None else None
        )
        turn = MessageTurn(
            role="assistant",
            content=prose,
            tool_calls=tool_calls if tool_calls else None,
            cost_usd=cost,
            latency_ms=float(latency_ms),
            input_tokens=int(response.usage.prompt_tokens),
            output_tokens=int(response.usage.completion_tokens),
        )

        if cost is not None:
            # Skip unpriced calls so the accumulator tracks only billable
            # spend — per AGENTS.md Cmd #8, "unpriced" is not the same as
            # "free".
            self.total_cost_usd += cost
        self.total_input_tokens += int(response.usage.prompt_tokens)
        self.total_output_tokens += int(response.usage.completion_tokens)
        return turn


# Factory signature: synchronous, no args, returns a constructed BaseClient.
# Same shape as in ``_openai_compat.ClientFactory`` — intentionally
# duplicated rather than imported to keep the OpenClaw adapter
# self-contained (it uses a different runtime: text-embedded tool calls,
# not OpenAI native).
from typing import Callable  # noqa: E402  (used only for type alias below)

ClientFactory = Callable[[], BaseClient]


def build_openclaw_agent(
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    temperature: float = 0.0,
    reasoning_effort: str = "low",
    max_tokens: int | None = None,
    client_factory: ClientFactory | None = None,
) -> OpenClawAgent:
    """Build an OpenClaw-protocol agent callable for the bench runner.

    Returns an :class:`OpenClawAgent` whose ``__call__(history, tools)``
    matches the runner's ``AgentFn`` signature. Per-instance cumulative
    spend is available via ``total_cost_usd``; per-turn telemetry is
    attached to each returned ``MessageTurn``.

    By default the agent wraps :class:`CerebrasClient` (the same backend
    used by the cerebras-direct sibling). Pass ``client_factory`` to
    drive a different backend through the OpenClaw protocol. The client
    is constructed lazily on the first completion.
    """
    if client_factory is None:

        def default_factory() -> CerebrasClient:
            return CerebrasClient(model=model, base_url=base_url, api_key=api_key)

        factory: ClientFactory = default_factory
    else:
        factory = client_factory

    return OpenClawAgent(
        factory,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        max_tokens=max_tokens,
    )
