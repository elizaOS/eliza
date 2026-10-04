"""BFCL-style agent_fn factory backed by the OpenClaw CLI.

BFCL (Berkeley Function-Call Leaderboard) drives the agent with a single
prompt plus an OpenAI-format ``tools=`` array and scores the emitted tool
call. Each invocation maps to one OpenClaw CLI spawn whose result is
distilled to ``{"name": ..., "arguments": ...}``.
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
from typing import Any, Awaitable, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from benchmarks.suites.bfcl import BFCLTestCase, FunctionCall

from openclaw_adapter.client import OpenClawClient

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


def _tool_choice_for_case(*, is_relevant: bool, tools: list[dict[str, Any]]) -> str:
    return "required" if is_relevant and bool(tools) else "none"


class OpenClawBFCLAgent:
    """BFCLRunner-compatible OpenClaw adapter using native tool calls."""

    def __init__(
        self,
        client: OpenClawClient | None = None,
        model_name: str | None = None,
        provider: str | None = None,
    ) -> None:
        self._model_name = _default_model_name(model_name)
        self._client = client or OpenClawClient(
            provider=provider or _default_underlying_provider(),
            model=self._model_name,
        )
        self._initialized = False

    @property
    def model_name(self) -> str:
        return self._model_name

    async def initialize(self) -> None:
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def setup_test_case(self, test_case: "BFCLTestCase") -> None:
        try:
            self._client.reset(task_id=test_case.id, benchmark="bfcl")
        except Exception as exc:
            logger.debug("OpenClaw reset failed (continuing): %s", exc)

    async def query(
        self,
        test_case: "BFCLTestCase",
        timeout_ms: int | None = None,
    ) -> tuple[list["FunctionCall"], str, float]:
        del timeout_ms
        if not self._initialized:
            await self.initialize()
        await self.setup_test_case(test_case)

        raw_tools = _bfcl_tools_formatter()(test_case.functions)
        tools, tool_name_map = _provider_safe_tools(raw_tools)
        tool_choice = _tool_choice_for_case(
            is_relevant=test_case.is_relevant,
            tools=tools,
        )
        start = time.time()
        response = self._client.send_message(
            test_case.question,
            context={
                "benchmark": "bfcl",
                "task_id": test_case.id,
                "category": test_case.category.value,
                "tools": tools,
                "tool_choice": tool_choice,
                "temperature": _DEFAULT_BFCL_TEMPERATURE,
                "is_relevant": test_case.is_relevant,
                "system_prompt": _DEFAULT_SYSTEM_PROMPT,
            },
        )
        latency_ms = (time.time() - start) * 1000

        params = response.params if isinstance(response.params, dict) else {}
        predicted: list[FunctionCall] = []
        for entry in _iter_call_records(params.get("tool_calls")):
            call = _call_from_record(entry)
            if call is not None:
                predicted.append(call)
        predicted = _restore_original_call_names(predicted, tool_name_map)
        raw_response = {
            "text": response.text or "",
            "thought": response.thought,
            "actions": response.actions,
            "params": params,
            "tool_name_map": tool_name_map,
        }
        return predicted, json.dumps(raw_response, ensure_ascii=True), latency_ms

    async def close(self) -> None:
        self._initialized = False


def build_bfcl_agent_fn(
    *,
    client: OpenClawClient | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[str, list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build an async BFCL-compatible callable.

    Returned signature::

        async def agent_fn(prompt: str, tools: list[dict]) -> dict

    The returned dict shape mirrors the hermes-adapter / eliza-adapter BFCL
    factories::

        {
            "name": <first tool call name, or "">,
            "arguments": <first tool call args, or {}>,
            "text": <assistant content>,
            "tool_calls": [{"name": str, "arguments": ...}, ...],
            "thought": <reasoning or None>,
        }
    """
    bridge = client or OpenClawClient()

    async def _agent_fn(
        prompt: str,
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        context: dict[str, object] = {
            "tools": tools or [],
            "tool_choice": "required" if tools else "none",
            "temperature": _DEFAULT_BFCL_TEMPERATURE,
            "system_prompt": system_prompt or _DEFAULT_SYSTEM_PROMPT,
        }
        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[openclaw-bfcl] send_message failed")
            raise RuntimeError("OpenClaw BFCL send_message failed") from exc

        raw_tool_calls = (
            resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        )
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                tool_calls.append(
                    {
                        "name": name,
                        "arguments": entry.get("arguments", {}),
                    }
                )

        first = tool_calls[0] if tool_calls else {"name": "", "arguments": {}}
        result: dict[str, Any] = {
            "name": first["name"],
            "arguments": first["arguments"],
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
        }
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


__all__ = ["OpenClawBFCLAgent", "build_bfcl_agent_fn"]
