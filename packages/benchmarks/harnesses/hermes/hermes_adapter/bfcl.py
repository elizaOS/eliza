"""BFCL-style agent_fn factory backed by hermes-agent.

BFCL (Berkeley Function-Call Leaderboard) drives the agent with a single
turn: a user prompt plus an OpenAI-format ``tools=`` array. The agent returns
either text or a structured list of function calls. There is no multi-turn
loop and no real tool execution — the runner scores the emitted calls.

This adapter exposes a builder ``build_bfcl_agent_fn`` that returns an async
callable matching the duck-typed shape BFCL runners expect.
"""

from __future__ import annotations

from benchmarks.suites.bfcl import (
    call_from_record as _call_from_record,
    iter_call_records as _iter_call_records,
    provider_safe_tools as _provider_safe_tools,
    restore_original_call_names as _restore_original_call_names,
)

import json
import logging
import os
import re
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

if TYPE_CHECKING:
    from benchmarks.suites.bfcl.types import BFCLTestCase, FunctionCall

logger = logging.getLogger(__name__)

_SAFE_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DEFAULT_BFCL_TEMPERATURE = 0.0
_DEFAULT_SYSTEM_PROMPT = (
    "You are solving a Berkeley Function-Calling Leaderboard task. "
    "Use native tool calls when one or more listed functions are relevant. "
    "When the user requests more than one operation, emit one separate native "
    "tool call for each requested operation, including repeated calls to the "
    "same function with different arguments. Do not merge separate operations "
    "into one call unless the function schema explicitly asks for an array. "
    "Use exactly the function names and parameter names from the provided tool "
    "schema; preserve case, underscores, camelCase, and declared defaults. "
    "Do not rename fields or invent aliases. If no listed function is relevant, "
    "respond without a tool call."
)


def _bfcl_types():
    from benchmarks.suites.bfcl.types import ArgumentValue, BFCLTestCase, FunctionCall

    return ArgumentValue, BFCLTestCase, FunctionCall


def _bfcl_tools_formatter():
    from benchmarks.suites.bfcl.plugin import generate_openai_tools_format

    return generate_openai_tools_format


def _bfcl_parser():
    from benchmarks.suites.bfcl.parser import FunctionCallParser

    return FunctionCallParser


def _unwrap_benchmark_action_calls(calls: list["FunctionCall"]) -> list["FunctionCall"]:
    """Normalize BENCHMARK_ACTION wrappers into underlying BFCL calls."""
    _, _, FunctionCall = _bfcl_types()
    normalized: list[FunctionCall] = []
    for call in calls:
        if call.name != "BENCHMARK_ACTION":
            normalized.append(call)
            continue
        wrapped = (
            call.arguments.get("calls") if isinstance(call.arguments, dict) else None
        )
        for entry in _iter_call_records(wrapped):
            unwrapped = _call_from_record(entry)
            if unwrapped is not None:
                normalized.append(unwrapped)
    return normalized or calls


def _extract_calls_from_response(
    text: str, params: dict[str, object]
) -> list["FunctionCall"]:
    """Extract BFCL calls from HermesClient native tool-call params.

    HermesClient surfaces provider-native tool calls in
    ``params['tool_calls']`` as ``{"name": ..., "arguments": ...}``.
    Text-only JSON is intentionally not treated as a successful tool call; BFCL
    cross-agent scoring should exercise the native function-calling channel.
    """
    del text
    calls: list[FunctionCall] = []

    for key in ("tool_calls", "calls"):
        for entry in _iter_call_records(params.get(key)):
            call = _call_from_record(entry)
            if call is not None:
                calls.append(call)

    if not calls:
        arguments_raw = params.get("arguments")
        if isinstance(arguments_raw, dict):
            for entry in _iter_call_records(arguments_raw.get("calls")):
                call = _call_from_record(entry)
                if call is not None:
                    calls.append(call)
        elif isinstance(arguments_raw, str):
            for entry in _iter_call_records(arguments_raw):
                call = _call_from_record(entry)
                if call is not None:
                    calls.append(call)

    if calls:
        return _unwrap_benchmark_action_calls(calls)

    return []


def _extract_prompt_only_calls(text: str) -> list["FunctionCall"]:
    """Parse calls from the prompt-only retry response channel."""
    return _unwrap_benchmark_action_calls(_bfcl_parser()().parse(text or ""))


def _default_underlying_provider() -> str:
    return (
        (
            os.environ.get("BENCHMARK_MODEL_PROVIDER")
            or os.environ.get("ELIZA_PROVIDER")
            or "cerebras"
        )
        .strip()
        .lower()
    )


def _default_model_name(model_name: str | None) -> str:
    if model_name:
        return model_name
    return (
        os.environ.get("BENCHMARK_MODEL_NAME")
        or os.environ.get("OPENAI_MODEL")
        or os.environ.get("CEREBRAS_MODEL")
        or "gemma-4-31b"
    )


def _is_tool_schema_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "wrong_api_format" in message
        or "schema grammar" in message
        or "response_format" in message
    )


def _tool_choice_for_case(*, is_relevant: bool, tools: list[dict[str, Any]]) -> str:
    return "required" if is_relevant and bool(tools) else "none"


class HermesBFCLAgent:
    """BFCLRunner-compatible agent wrapper backed by HermesClient."""

    def __init__(
        self,
        client: HermesClient | None = None,
        model_name: str | None = None,
        provider: str | None = None,
    ) -> None:
        self._model_name = _default_model_name(model_name)
        if client is None:
            self._client = HermesClient(
                provider=provider or _default_underlying_provider(),
                model=self._model_name,
            )
        else:
            self._client = client
        self._initialized = False

    @property
    def model_name(self) -> str:
        return self._model_name

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=60)
        self._initialized = True

    async def setup_test_case(self, test_case: "BFCLTestCase") -> None:
        return None

    async def query(
        self,
        test_case: "BFCLTestCase",
        timeout_ms: int | None = None,
    ) -> tuple[list["FunctionCall"], str, float]:
        del timeout_ms
        if not self._initialized:
            await self.initialize()

        try:
            self._client.reset(task_id=test_case.id, benchmark="bfcl")
        except Exception as exc:
            logger.debug("Hermes reset failed (continuing): %s", exc)

        raw_tools = _bfcl_tools_formatter()(test_case.functions)
        tools, tool_name_map = _provider_safe_tools(raw_tools)
        tool_choice = _tool_choice_for_case(
            is_relevant=test_case.is_relevant,
            tools=tools,
        )

        prompt_only_retry = False
        start = time.time()
        try:
            response = self._client.send_message(
                text=test_case.question,
                context={
                    "benchmark": "bfcl",
                    "task_id": test_case.id,
                    "category": test_case.category.value,
                    "tools": tools,
                    "system_prompt": _DEFAULT_SYSTEM_PROMPT,
                    "tool_choice": tool_choice,
                    "temperature": _DEFAULT_BFCL_TEMPERATURE,
                    "is_relevant": test_case.is_relevant,
                },
            )
        except RuntimeError as exc:
            if not _is_tool_schema_error(exc):
                raise
            prompt_only_retry = True
            logger.info(
                "Hermes BFCL native tool schema rejected for %s; retrying prompt-only",
                test_case.id,
            )
            response = self._client.send_message(
                text=(
                    "Return only a JSON array of function calls in this exact shape: "
                    '[{"name": string, "arguments": object}]. Return [] if no listed '
                    "function is relevant.\n\n"
                    f"Available functions:\n{json.dumps(tools, ensure_ascii=True)}\n\n"
                    f"User query: {test_case.question}"
                ),
                context={
                    "benchmark": "bfcl",
                    "task_id": test_case.id,
                    "category": test_case.category.value,
                    "system_prompt": (
                        "You are solving a BFCL function-calling task. "
                        "Do not use native tool calls in this retry; answer with JSON only."
                    ),
                    "tool_choice": "none",
                    "temperature": _DEFAULT_BFCL_TEMPERATURE,
                    "is_relevant": test_case.is_relevant,
                    "tool_schema_retry": True,
                },
            )
        latency_ms = (time.time() - start) * 1000

        params = response.params if isinstance(response.params, dict) else {}
        if prompt_only_retry:
            predicted = _extract_prompt_only_calls(response.text or "")
        else:
            predicted = _extract_calls_from_response(response.text or "", params)
        predicted = _restore_original_call_names(predicted, tool_name_map)
        raw_response = {
            "text": response.text or "",
            "thought": response.thought,
            "actions": response.actions,
            "params": params,
            "tool_schema_retry": prompt_only_retry,
            "tool_name_map": tool_name_map,
        }

        return predicted, json.dumps(raw_response, ensure_ascii=True), latency_ms

    async def close(self) -> None:
        self._initialized = False


def build_bfcl_agent_fn(
    *,
    client: HermesClient | None = None,
    fixtures: dict[str, Any] | None = None,
    system_prompt: str | None = None,
) -> Callable[[str, list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build an async BFCL-compatible callable.

    Returned signature::

        async def agent_fn(prompt: str, tools: list[dict]) -> dict

    The returned dict shape is::

        {
            "text": <assistant content>,
            "tool_calls": [{"name": str, "arguments": <str|dict>}, ...],
            "thought": <reasoning_content or None>,
        }
    """
    del fixtures  # accepted for parity, currently unused
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)

    async def _agent_fn(prompt: str, tools: list[dict[str, Any]]) -> dict[str, Any]:
        context: dict[str, object] = {
            "tools": tools or [],
            "tool_choice": "required" if tools else "none",
            "temperature": _DEFAULT_BFCL_TEMPERATURE,
            "system_prompt": system_prompt or _DEFAULT_SYSTEM_PROMPT,
        }
        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[hermes-bfcl] send_message failed")
            raise RuntimeError("hermes BFCL send_message failed") from exc

        raw_tool_calls = (
            resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        )
        tool_calls: list[dict[str, Any]] = []
        for call in _extract_calls_from_response(
            resp.text or "", {"tool_calls": raw_tool_calls}
        ):
            tool_calls.append({"name": call.name, "arguments": call.arguments})

        return {
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
        }

    return _agent_fn
