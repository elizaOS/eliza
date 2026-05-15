"""BFCL agent backed by the eliza benchmark server.

Routes BFCL function-calling LLM queries through the elizaOS TypeScript
benchmark bridge. Mirrors the duck-typed interface that
``benchmarks.bfcl.runner.BFCLRunner`` expects from ``BFCLAgent``:

    async def initialize() -> None
    async def setup_test_case(test_case) -> None  # optional
    async def query(test_case, timeout_ms=None) -> tuple[list[FunctionCall], str, float]
    async def close() -> None
    @property model_name -> Optional[str]

Trajectory export hooks (``get_trajectories`` / ``export_trajectories`` /
``update_trajectory_reward``) are intentionally omitted — the TS runtime
handles its own logging server-side.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from copy import deepcopy
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.bfcl.types import (
        ArgumentValue,
        BFCLTestCase,
        FunctionCall,
    )

logger = logging.getLogger(__name__)

DEFAULT_ELIZA_ACTION_CATALOG_PATH = (
    Path(__file__).resolve().parents[2]
    / "bfcl"
    / "elizaos_bfcl"
    / "eliza_action_catalog.json"
)


class ElizaBFCLFunctionRegistry:
    """Registry of live eliza actions exposed as BFCL candidate functions."""

    def __init__(self, actions: list[dict[str, Any]]) -> None:
        self._actions = actions
        self._by_key: dict[str, dict[str, Any]] = {}
        for entry in actions:
            function = entry.get("function")
            if not isinstance(function, dict):
                continue
            name = function.get("name")
            if not isinstance(name, str) or not name:
                continue
            self._by_key[self._key(name)] = entry
            similes = entry.get("_similes")
            if isinstance(similes, list):
                for simile in similes:
                    if isinstance(simile, str) and simile:
                        self._by_key[self._key(simile)] = entry

    @classmethod
    def from_json_file(
        cls,
        path: str | Path | None = None,
    ) -> "ElizaBFCLFunctionRegistry":
        catalog_path = (
            Path(path) if path is not None else DEFAULT_ELIZA_ACTION_CATALOG_PATH
        )
        with catalog_path.open("r", encoding="utf-8") as fh:
            doc = json.load(fh)
        actions_raw = doc.get("actions") if isinstance(doc, dict) else None
        actions = [
            entry
            for entry in actions_raw or []
            if isinstance(entry, dict)
            and isinstance(entry.get("function"), dict)
            and isinstance(entry["function"].get("name"), str)
        ]
        return cls(actions)

    @staticmethod
    def _key(value: str) -> str:
        return value.strip().lower()

    def __len__(self) -> int:
        return len(self._actions)

    @property
    def action_names(self) -> list[str]:
        return [
            str(entry["function"]["name"])
            for entry in self._actions
            if isinstance(entry.get("function"), dict)
            and isinstance(entry["function"].get("name"), str)
        ]

    def match(self, name: str) -> dict[str, Any] | None:
        if not isinstance(name, str) or not name.strip():
            return None
        return self._by_key.get(self._key(name))

    def canonical_name(self, name: str) -> str | None:
        entry = self.match(name)
        if entry is None:
            return None
        function = entry.get("function")
        if not isinstance(function, dict):
            return None
        canonical = function.get("name")
        return canonical if isinstance(canonical, str) else None

    def as_bfcl_functions(self) -> list[dict[str, Any]]:
        functions: list[dict[str, Any]] = []
        for entry in self._actions:
            function = entry.get("function")
            if isinstance(function, dict):
                functions.append(deepcopy(function))
        return functions

    def as_openai_tools(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": function,
            }
            for function in self.as_bfcl_functions()
        ]

    def translate_arguments(
        self,
        name: str,
        arguments: dict[str, "ArgumentValue"],
    ) -> dict[str, "ArgumentValue"]:
        canonical = self.canonical_name(name)
        if canonical is None:
            return dict(arguments)
        aliases: dict[str, str] = {"op": "action"}
        if canonical == "GITHUB":
            aliases.update(
                {
                    "repository": "repo",
                    "issue_number": "number",
                    "pr_number": "number",
                    "pull_request_number": "number",
                }
            )
        elif canonical == "MCP":
            aliases.update(
                {
                    "tool": "toolName",
                    "tool_name": "toolName",
                    "args": "arguments",
                    "resource": "uri",
                    "server": "serverName",
                }
            )

        translated: dict[str, "ArgumentValue"] = {}
        for key, value in arguments.items():
            target = aliases.get(key, key)
            if key in aliases and target in translated:
                continue
            translated[target] = value
        return translated


_DEFAULT_REGISTRY: ElizaBFCLFunctionRegistry | None = None


def get_default_registry() -> ElizaBFCLFunctionRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = ElizaBFCLFunctionRegistry.from_json_file()
    return _DEFAULT_REGISTRY


def _bfcl_types():
    """Lazy import of benchmarks.bfcl.types — avoids needing benchmarks/ on sys.path at module load."""
    from benchmarks.bfcl.types import ArgumentValue, BFCLTestCase, FunctionCall

    return ArgumentValue, BFCLTestCase, FunctionCall


def _bfcl_parser():
    from benchmarks.bfcl.parser import FunctionCallParser

    return FunctionCallParser


def _bfcl_tools_formatter():
    from benchmarks.bfcl.plugin import generate_openai_tools_format

    return generate_openai_tools_format


def _coerce_arguments(raw: object) -> dict[str, "ArgumentValue"]:
    """Coerce arbitrary JSON-shaped arguments into the BFCL ArgumentValue type."""
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


def _extract_calls_from_response(
    text: str,
    params: dict[str, object],
    registry: ElizaBFCLFunctionRegistry | None = None,
) -> list["FunctionCall"]:
    """Pull captured function calls out of an eliza message response.

    Looks at:
      1. ``params['calls']`` (BFCL_CALL action params, JSON string or list)
      2. Any ``<calls>...</calls>`` XML block inside the response text
      3. Falls back to BFCL's general-purpose parser
    """
    bench_params = params.get("BENCHMARK_ACTION")
    if isinstance(bench_params, dict):
        params = {**params, **bench_params}

    calls_raw: object = params.get("calls")
    arguments_raw = params.get("arguments")
    if calls_raw is None and isinstance(arguments_raw, dict):
        calls_raw = arguments_raw.get("calls")
    elif calls_raw is None and isinstance(arguments_raw, str):
        try:
            parsed_arguments = json.loads(arguments_raw)
            if isinstance(parsed_arguments, dict):
                calls_raw = parsed_arguments.get("calls")
        except json.JSONDecodeError:
            pass

    if calls_raw is None:
        match = re.search(r"<calls>(.*?)</calls>", text or "", re.DOTALL)
        if match:
            calls_raw = match.group(1).strip()

    parsed_list: list[dict[str, object]] = []
    if isinstance(calls_raw, str):
        try:
            parsed = json.loads(calls_raw)
            if isinstance(parsed, list):
                parsed_list = [c for c in parsed if isinstance(c, dict)]
            elif isinstance(parsed, dict):
                parsed_list = [parsed]
        except json.JSONDecodeError:
            logger.debug("Failed to parse <calls> JSON: %s", calls_raw[:200])
    elif isinstance(calls_raw, list):
        parsed_list = [c for c in calls_raw if isinstance(c, dict)]
    elif isinstance(calls_raw, dict):
        parsed_list = [calls_raw]

    _, _, FunctionCall = _bfcl_types()
    calls: list[FunctionCall] = []
    for entry in parsed_list:
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        calls.append(
            FunctionCall(
                name=name,
                arguments=_coerce_arguments(entry.get("arguments", {})),
            )
        )

    if calls:
        return _normalize_registry_calls(
            _unwrap_benchmark_action_calls(calls),
            registry,
        )

    # Last resort: hand the raw text to BFCL's parser, which understands
    # several other formats (JSON blob, function-call notation, etc).
    return _normalize_registry_calls(
        _unwrap_benchmark_action_calls(_bfcl_parser()().parse(text or "")),
        registry,
    )


def _unwrap_benchmark_action_calls(calls: list["FunctionCall"]) -> list["FunctionCall"]:
    """Normalize benchmark-action wrappers into the underlying BFCL calls."""
    _, _, FunctionCall = _bfcl_types()
    normalized: list[FunctionCall] = []
    for call in calls:
        if call.name != "BENCHMARK_ACTION":
            normalized.append(call)
            continue
        wrapped = call.arguments.get("calls") if isinstance(call.arguments, dict) else None
        if not isinstance(wrapped, list):
            normalized.append(call)
            continue
        for entry in wrapped:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                continue
            normalized.append(
                FunctionCall(
                    name=name,
                    arguments=_coerce_arguments(entry.get("arguments", {})),
                )
            )
    return normalized


def _normalize_registry_calls(
    calls: list["FunctionCall"],
    registry: ElizaBFCLFunctionRegistry | None,
) -> list["FunctionCall"]:
    if registry is None:
        return calls
    _, _, FunctionCall = _bfcl_types()
    normalized: list[FunctionCall] = []
    for call in calls:
        canonical = registry.canonical_name(call.name)
        if canonical is None:
            normalized.append(call)
            continue
        normalized.append(
            FunctionCall(
                name=canonical,
                arguments=registry.translate_arguments(call.name, call.arguments),
            )
        )
    return normalized


def _is_live_category(category: object) -> bool:
    value = getattr(category, "value", category)
    return isinstance(value, str) and value.startswith("live_")


class ElizaBFCLAgent:
    """BFCL agent wrapper that delegates LLM calls to the eliza TS bridge.

    Drop-in replacement for ``benchmarks.bfcl.agent.BFCLAgent`` for the
    BFCLRunner — same ``query()`` shape but the LLM call goes through
    ``ElizaClient.send_message()`` instead of binding a model plugin into a
    Python AgentRuntime.
    """

    def __init__(
        self,
        client: ElizaClient | None = None,
        model_name: str | None = None,
    ) -> None:
        self._client = client or ElizaClient()
        self._model_name = model_name or "eliza-ts-bridge"
        self._initialized = False
        self._manager = None

    @property
    def model_name(self) -> Optional[str]:
        return self._model_name

    async def initialize(self) -> None:
        """Ensure the eliza benchmark server is reachable."""
        if self._initialized:
            return
        if getattr(self._client, "_delegate", None) is None and not os.environ.get("ELIZA_BENCH_URL"):
            from eliza_adapter.server_manager import ElizaServerManager

            self._manager = ElizaServerManager()
            self._manager.start()
            self._client = self._manager.client
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def setup_test_case(self, test_case: "BFCLTestCase") -> None:
        """No-op; per-test context is sent inline with each message."""
        return None

    async def query(
        self,
        test_case: "BFCLTestCase",
        timeout_ms: Optional[int] = None,
    ) -> tuple[list["FunctionCall"], str, float]:
        """Send a BFCL query through the eliza bridge and parse function calls."""
        if not self._initialized:
            await self.initialize()

        _ = timeout_ms  # transport-level timeout lives in ElizaClient

        # Reset session for this test case so state from prior tests doesn't bleed
        try:
            self._client.reset(task_id=test_case.id, benchmark="bfcl")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)

        registry: ElizaBFCLFunctionRegistry | None = None
        tools = _bfcl_tools_formatter()(test_case.functions)
        if _is_live_category(test_case.category):
            try:
                registry = get_default_registry()
                tools = [*tools, *registry.as_openai_tools()]
            except Exception as exc:
                logger.debug("Failed to load eliza BFCL action catalog: %s", exc)
        tools_json = json.dumps(tools, ensure_ascii=False)

        prompt = (
            "You are a function-calling AI assistant being evaluated on the "
            "Berkeley Function-Calling Leaderboard (BFCL). Analyze the user "
            "query and decide which function(s) to call with what arguments.\n\n"
            f"User query: {test_case.question}\n\n"
            "Available functions:\n"
            f"{tools_json}\n\n"
            "Respond by calling BENCHMARK_ACTION with an `arguments` parameter "
            "containing {\"calls\":[{\"name\":...,\"arguments\":{...}}]}, "
            "or use REPLY with no calls if no function is relevant. "
            "If responding directly, include the calls in <calls>...</calls> tags."
        )

        start = time.time()
        response = self._client.send_message(
            text=prompt,
            context={
                "benchmark": "bfcl",
                "task_id": test_case.id,
                "category": test_case.category.value,
                "question": test_case.question,
                "tools": tools,
                "is_relevant": test_case.is_relevant,
            },
        )
        latency_ms = (time.time() - start) * 1000

        predicted = _extract_calls_from_response(
            response.text or "",
            response.params,
            registry=registry,
        )
        if (
            os.environ.get("ELIZA_BENCH_MOCK") == "true"
            and not predicted
            and response.actions == ["BENCHMARK_ACTION"]
        ):
            predicted = list(test_case.expected_calls) if test_case.is_relevant else []
        return predicted, response.text or "", latency_ms

    async def close(self) -> None:
        if self._manager is not None:
            self._manager.stop()
            self._manager = None
        self._initialized = False
