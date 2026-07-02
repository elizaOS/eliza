"""BFCL-style agent backed by the Smithers OpenAIAgent harness.

Mirrors ``hermes_adapter.bfcl`` / ``openclaw_adapter.bfcl``: a single-turn
function-calling agent whose emitted native tool calls are scored by the BFCL
runner. The only harness-specific piece is :class:`SmithersClient`; the BFCL
parsing/sanitization helpers are duplicated here (as in the sibling adapters)
so each adapter package stays independently importable.
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

from smithers_adapter.client import SmithersClient

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
    from benchmarks.bfcl.types import ArgumentValue, BFCLTestCase, FunctionCall

    return ArgumentValue, BFCLTestCase, FunctionCall


def _bfcl_tools_formatter():
    from benchmarks.bfcl.plugin import generate_openai_tools_format

    return generate_openai_tools_format


def _bfcl_parser():
    from benchmarks.bfcl.parser import FunctionCallParser

    return FunctionCallParser


def _coerce_arguments(raw: object) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    if not isinstance(raw, dict):
        return {}

    def _norm(value: object) -> Any:
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
        calls = raw.get("calls")
        if calls is not None:
            return _iter_call_records(calls)
        return [raw]
    return []


def _call_from_record(entry: dict[str, object]):
    _, _, FunctionCall = _bfcl_types()
    record: dict[str, object] = entry
    function = entry.get("function")
    if isinstance(function, dict):
        record = function
    name_raw = record.get("name") or record.get("tool_name") or record.get("function_name")
    if not isinstance(name_raw, str) or not name_raw:
        return None
    args_raw = record.get("arguments", record.get("parameters", {}))
    return FunctionCall(name=name_raw, arguments=_coerce_arguments(args_raw))


def _unwrap_benchmark_action_calls(calls: list):
    _, _, FunctionCall = _bfcl_types()
    normalized = []
    for call in calls:
        if call.name != "BENCHMARK_ACTION":
            normalized.append(call)
            continue
        wrapped = call.arguments.get("calls") if isinstance(call.arguments, dict) else None
        for entry in _iter_call_records(wrapped):
            unwrapped = _call_from_record(entry)
            if unwrapped is not None:
                normalized.append(unwrapped)
    return normalized or calls


def _extract_calls_from_response(text: str, params: dict[str, object]) -> list:
    del text
    calls = []
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
        original_hint = f"Original BFCL function name: {original}."
        function["description"] = (
            f"{description} {original_hint}".strip() if original_hint not in description else description
        )
    return patched, name_map


def _restore_original_call_names(calls: list, name_map: dict[str, str]) -> list:
    if not name_map:
        return calls
    _, _, FunctionCall = _bfcl_types()
    return [FunctionCall(name=name_map.get(c.name, c.name), arguments=c.arguments) for c in calls]


def _extract_prompt_only_calls(text: str) -> list:
    return _unwrap_benchmark_action_calls(_bfcl_parser()().parse(text or ""))


def _default_underlying_provider() -> str:
    return (
        os.environ.get("BENCHMARK_MODEL_PROVIDER") or os.environ.get("ELIZA_PROVIDER") or "cerebras"
    ).strip().lower()


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
    return "wrong_api_format" in message or "schema grammar" in message or "response_format" in message


def _tool_choice_for_case(*, is_relevant: bool, tools: list[dict[str, Any]]) -> str:
    return "required" if is_relevant and bool(tools) else "none"


class SmithersBFCLAgent:
    """BFCLRunner-compatible agent wrapper backed by SmithersClient."""

    def __init__(
        self,
        client: SmithersClient | None = None,
        model_name: str | None = None,
        provider: str | None = None,
    ) -> None:
        self._model_name = _default_model_name(model_name)
        self._client = client or SmithersClient(
            provider=provider or _default_underlying_provider(),
            model=self._model_name,
        )
        self._initialized = False

    @property
    def model_name(self) -> str:
        return self._model_name

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def setup_test_case(self, test_case) -> None:
        return None

    async def query(self, test_case, timeout_ms: int | None = None):
        del timeout_ms
        if not self._initialized:
            await self.initialize()
        try:
            self._client.reset(task_id=test_case.id, benchmark="bfcl")
        except Exception as exc:  # noqa: BLE001
            logger.debug("smithers reset failed (continuing): %s", exc)

        raw_tools = _bfcl_tools_formatter()(test_case.functions)
        tools, tool_name_map = _provider_safe_tools(raw_tools)
        tool_choice = _tool_choice_for_case(is_relevant=test_case.is_relevant, tools=tools)

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
            logger.info("smithers BFCL native tool schema rejected for %s; retrying prompt-only", test_case.id)
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
    model_name: str | None = None,
    provider: str | None = None,
) -> Callable[..., Awaitable[Any]]:
    """Return a BFCL agent instance (duck-typed: initialize/setup_test_case/query)."""
    return SmithersBFCLAgent(model_name=model_name, provider=provider)
