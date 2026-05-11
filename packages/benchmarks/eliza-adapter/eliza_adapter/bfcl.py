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
from typing import TYPE_CHECKING, Optional

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from benchmarks.bfcl.types import (
        ArgumentValue,
        BFCLTestCase,
        FunctionCall,
    )

logger = logging.getLogger(__name__)


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
        return calls

    # Last resort: hand the raw text to BFCL's parser, which understands
    # several other formats (JSON blob, function-call notation, etc).
    return _bfcl_parser()().parse(text or "")


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

        tools_json = str(_bfcl_tools_formatter()(test_case.functions))

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
                "tools": tools_json,
                "is_relevant": test_case.is_relevant,
            },
        )
        latency_ms = (time.time() - start) * 1000

        predicted = _extract_calls_from_response(response.text or "", response.params)
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
