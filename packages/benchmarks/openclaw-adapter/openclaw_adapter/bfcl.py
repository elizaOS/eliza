"""BFCL-style agent_fn factory backed by the OpenClaw CLI.

BFCL (Berkeley Function-Call Leaderboard) drives the agent with a single
prompt plus an OpenAI-format ``tools=`` array and scores the emitted tool
call. Each invocation maps to one OpenClaw CLI spawn whose result is
distilled to ``{"name": ..., "arguments": ...}``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from copy import deepcopy
from hashlib import sha1
from typing import Any, Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)

_SAFE_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _bfcl_types():
    from benchmarks.bfcl.types import ArgumentValue, BFCLTestCase, FunctionCall

    return ArgumentValue, BFCLTestCase, FunctionCall


def _bfcl_tools_formatter():
    from benchmarks.bfcl.plugin import generate_openai_tools_format

    return generate_openai_tools_format


def _coerce_arguments(raw: object) -> dict[str, "ArgumentValue"]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    if not isinstance(raw, dict):
        return {}

    def _norm(value: object) -> "ArgumentValue":
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [_norm(v) for v in value]
        if isinstance(value, dict):
            return {str(k): _norm(v) for k, v in value.items()}
        return str(value)

    return {str(k): _norm(v) for k, v in raw.items()}


def _iter_call_records(raw: object) -> list[dict[str, object]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        calls = raw.get("calls") or raw.get("tool_calls")
        if calls is not None:
            return _iter_call_records(calls)
        return [raw]
    return []


def _call_from_record(entry: dict[str, object]) -> "FunctionCall | None":
    _, _, FunctionCall = _bfcl_types()
    record: dict[str, object] = entry
    function = entry.get("function")
    if isinstance(function, dict):
        record = function
    name_raw = record.get("name") or record.get("tool_name") or record.get("function_name")
    if not isinstance(name_raw, str) or not name_raw:
        return None
    args_raw = record.get("arguments", record.get("parameters", record.get("args", {})))
    return FunctionCall(name=name_raw, arguments=_coerce_arguments(args_raw))


def _provider_safe_tool_name(name: str, used: set[str]) -> str:
    if _SAFE_TOOL_NAME_RE.match(name) and name not in used:
        used.add(name)
        return name

    candidate = re.sub(r"[^A-Za-z0-9_-]", "_", name).strip("_")
    if not candidate:
        candidate = "bfcl_tool"
    if not re.match(r"^[A-Za-z0-9_]", candidate):
        candidate = f"bfcl_{candidate}"
    if len(candidate) > 64:
        digest = sha1(name.encode("utf-8")).hexdigest()[:8]
        candidate = f"{candidate[:55]}_{digest}"
    base = candidate
    index = 2
    while candidate in used:
        suffix = f"_{index}"
        candidate = f"{base[:64 - len(suffix)]}{suffix}"
        index += 1
    used.add(candidate)
    return candidate


def _provider_safe_tools(tools: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    used: set[str] = set()
    name_map: dict[str, str] = {}
    patched = deepcopy(tools)
    for tool in patched:
        function = tool.get("function")
        if not isinstance(function, dict):
            continue
        original = function.get("name")
        if not isinstance(original, str) or not original:
            continue
        safe = _provider_safe_tool_name(original, used)
        name_map[safe] = original
        if safe == original:
            continue
        function["name"] = safe
        description = str(function.get("description") or "")
        hint = f"Original BFCL function name: {original}."
        function["description"] = f"{description} {hint}".strip()
    return patched, name_map


def _restore_original_call_names(
    calls: list["FunctionCall"],
    name_map: dict[str, str],
) -> list["FunctionCall"]:
    if not name_map:
        return calls
    _, _, FunctionCall = _bfcl_types()
    return [
        FunctionCall(name=name_map.get(call.name, call.name), arguments=call.arguments)
        for call in calls
    ]


def _default_underlying_provider() -> str:
    return (
        os.environ.get("BENCHMARK_MODEL_PROVIDER")
        or os.environ.get("ELIZA_PROVIDER")
        or "cerebras"
    ).strip().lower()


def _default_model_name(model_name: str | None) -> str:
    if model_name:
        return model_name
    return (
        os.environ.get("BENCHMARK_MODEL_NAME")
        or os.environ.get("OPENAI_MODEL")
        or os.environ.get("CEREBRAS_MODEL")
        or "gpt-oss-120b"
    )


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
            direct_openai_compatible=True,
            allow_text_tool_calls=False,
        )
        self._initialized = False

    @property
    def model_name(self) -> str:
        return self._model_name

    async def initialize(self) -> None:
        # Direct OpenAI-compatible mode does not require the OpenClaw CLI binary
        # to be installed or probed.
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
        start = time.time()
        response = self._client.send_message(
            test_case.question,
            context={
                "benchmark": "bfcl",
                "task_id": test_case.id,
                "category": test_case.category.value,
                "tools": tools,
                "tool_choice": "auto",
                "is_relevant": test_case.is_relevant,
                "system_prompt": (
                    "You are solving a Berkeley Function-Calling Leaderboard "
                    "task. Use native tool calls when one or more listed "
                    "functions are relevant. If no listed function is relevant, "
                    "respond without a tool call."
                ),
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
        context: dict[str, object] = {"tools": tools or []}
        if system_prompt:
            context["system_prompt"] = system_prompt
        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[openclaw-bfcl] send_message failed")
            raise RuntimeError("OpenClaw BFCL send_message failed") from exc

        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
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
