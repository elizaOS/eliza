"""
BFCL Execution Evaluator
========================

Drives the real BFCL executable runtime (see
``benchmarks.bfcl.executable_runtime``) — actually invoking the upstream
tool implementations (GorillaFileSystem, MathAPI, TwitterAPI, ...) against
the test's ``initial_config`` and comparing per-call output against the
ground-truth execution.

This module replaces the previous synthetic always-success mock evaluator,
in which ``register_mocks_from_definitions`` would auto-register mock
handlers that returned ``{"status": "success"}`` for every call. That
behaviour made ``exec_accuracy`` meaningless and is now removed.

Safety net:
  * Tests requiring network or external credentials (REST, web_search)
    raise ``RuntimeNetworkRequired`` from the runtime and the caller
    should mark them ``SKIPPED_NO_CREDENTIALS`` (NOT passed).
  * Categories whose tooling we don't vendor (e.g. SQL is not in the
    upstream executable runtime) are reported as skipped via
    ``ExecutionEvaluator.is_supported(category)``.

A small back-compat surface remains:
  * ``register_mock`` / ``register_result`` — for user-supplied stubs.
    These NEVER auto-pass; they merely allow specific handlers when the
    caller explicitly registers them (used by unit tests).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Optional

from benchmarks.bfcl.executable_runtime import (
    CLASS_FILE_PATH_MAPPING,
    NETWORK_REQUIRED_CLASSES,
    ExecutableRuntime,
    RESTCallSpec,
    RESTExecutionError,
    RESTRateLimited,
    RESTRunner,
    RuntimeNetworkRequired,
    agentic_checker,
)
from benchmarks.bfcl.types import (
    ArgumentValue,
    BFCLCategory,
    FunctionCall,
    FunctionDefinition,
)

logger = logging.getLogger(__name__)


# Categories that the executable runtime can actually score.
# Other categories (SQL, JAVA, JAVASCRIPT, REST_API without network) are
# AST-only or require external infra we don't ship.
EXEC_SUPPORTED_CATEGORIES: set[BFCLCategory] = {
    BFCLCategory.MULTI_TURN_BASE,
    BFCLCategory.MULTI_TURN_MISS_FUNC,
    BFCLCategory.MULTI_TURN_MISS_PARAM,
    BFCLCategory.MULTI_TURN_LONG_CONTEXT,
    # Memory categories are scored by the agentic_checker over the final
    # model response after the snapshot-backed memory runtime has been
    # exercised. Vector + rec_sum need optional deps; the runner gates
    # them on a try/except around runtime construction.
    BFCLCategory.MEMORY_KV,
    BFCLCategory.MEMORY_VECTOR,
    BFCLCategory.MEMORY_REC_SUM,
}


MockHandler = Callable[..., Awaitable[object] | object]


class MockFunctionRegistry:
    """User-supplied stub registry. Only consulted when the caller
    explicitly registers a handler. There is no longer an auto-success
    fallback."""

    def __init__(self) -> None:
        self._functions: dict[str, MockHandler] = {}
        self._results: dict[str, object] = {}

    def register(self, name: str, handler: MockHandler) -> None:
        self._functions[name.lower()] = handler

    def register_result(self, name: str, result: object) -> None:
        self._results[name.lower()] = result

    def get_handler(self, name: str) -> Optional[MockHandler]:
        return self._functions.get(name.lower())

    def get_result(self, name: str) -> Optional[object]:
        return self._results.get(name.lower())

    def has_function(self, name: str) -> bool:
        return (
            name.lower() in self._functions
            or name.lower() in self._results
        )

    def clear(self) -> None:
        self._functions.clear()
        self._results.clear()


class ExecutionEvaluator:
    """Drives the upstream BFCL executable runtime for multi-turn tests."""

    def __init__(
        self,
        timeout_ms: int = 5000,
        allow_partial_execution: bool = False,
        enable_network: bool = False,
    ) -> None:
        self.timeout_ms = timeout_ms
        self.allow_partial_execution = allow_partial_execution
        self.enable_network = enable_network
        self.registry = MockFunctionRegistry()

    # ------------------------------------------------------------------
    # Capability checks
    # ------------------------------------------------------------------
    @staticmethod
    def is_supported(category: BFCLCategory) -> bool:
        """Whether the executable runtime can score this category."""
        return category in EXEC_SUPPORTED_CATEGORIES

    def requires_network(self, involved_classes: Optional[list[str]]) -> bool:
        if not involved_classes:
            return False
        return any(c in NETWORK_REQUIRED_CLASSES for c in involved_classes)

    # ------------------------------------------------------------------
    # Multi-turn / executable scoring
    # ------------------------------------------------------------------
    def evaluate_multi_turn(
        self,
        *,
        predicted_per_turn: list[list[str]],
        ground_truth_per_turn: list[list[str]],
        involved_classes: list[str],
        initial_config: dict[str, object],
        long_context: bool = False,
    ) -> tuple[bool, dict[str, object]]:
        """Score a multi-turn entry by executing both the predicted and
        ground-truth call sequences against fresh runtime instances and
        comparing final state.

        Returns ``(exec_success, details)``.

        Raises ``RuntimeNetworkRequired`` if a network-gated class is
        required and ``enable_network`` is False — the caller is expected
        to translate this into a ``SKIPPED_NO_CREDENTIALS`` status.
        """
        details: dict[str, object] = {}

        # Run model trajectory
        model_runtime = ExecutableRuntime(
            involved_classes=involved_classes,
            initial_config=initial_config,
            long_context=long_context,
            enable_network=self.enable_network,
        )
        model_outputs: list[list[str]] = []
        for turn_calls in predicted_per_turn:
            model_outputs.append(model_runtime.execute_calls(turn_calls))

        # Run ground-truth trajectory
        gt_runtime = ExecutableRuntime(
            involved_classes=involved_classes,
            initial_config=initial_config,
            long_context=long_context,
            enable_network=self.enable_network,
        )
        gt_outputs: list[list[str]] = []
        for turn_calls in ground_truth_per_turn:
            gt_outputs.append(gt_runtime.execute_calls(turn_calls))

        # Compare per-class instance state (the upstream multi-turn
        # checker uses state equality + response substring matching).
        state_match = True
        for class_name in involved_classes:
            m_inst = model_runtime._instances.get(class_name)
            g_inst = gt_runtime._instances.get(class_name)
            if not self._state_equal(m_inst, g_inst):
                state_match = False
                details[f"state_mismatch:{class_name}"] = True

        details["model_outputs"] = [o for turn in model_outputs for o in turn]
        details["ground_truth_outputs"] = [o for turn in gt_outputs for o in turn]
        details["state_match"] = state_match
        return state_match, details

    @staticmethod
    def _state_equal(a: object, b: object) -> bool:
        """Compare tool-instance state. Falls back to ``repr`` when the
        backend doesn't expose serializable state. Upstream uses a similar
        pattern via per-class custom equality, which we deliberately don't
        re-implement — instance ``__dict__`` comparison is the safe default
        and matches upstream's coarse-grained state check."""
        if a is None or b is None:
            return a is b
        if hasattr(a, "__dict__") and hasattr(b, "__dict__"):
            try:
                return a.__dict__ == b.__dict__
            except Exception:
                return repr(a) == repr(b)
        return repr(a) == repr(b)

    # ------------------------------------------------------------------
    # Memory category scoring
    # ------------------------------------------------------------------
    def evaluate_memory(
        self,
        *,
        backend: str,
        scenario: str,
        test_id: str,
        prereq_messages: Optional[list[str]] = None,
        agent_tool_calls: list[str],
        agent_final_response: str,
        possible_answers: list[str],
    ) -> tuple[bool, dict[str, object]]:
        """Score a memory entry by exercising the snapshot-backed memory
        runtime, then doing a substring match against the possible answers.

        Args:
            backend: memory backend name (``kv`` / ``vector`` / ``rec_sum``).
            scenario: prereq scenario name (``finance`` / ``customer`` / ...).
            test_id: full test entry id; used for the snapshot folder
                layout. Must include the upstream-canonical prefix
                conventions if it's a prereq entry.
            prereq_messages: optional list of user messages from the prereq
                conversation chain. We *don't* drive an LLM during the
                prereq; instead we pre-populate the memory snapshot using
                the API surface so the test entry sees realistic state.
                Callers that want the real prereq write phase (LLM-driven)
                should populate the snapshot directly and pass an empty list.
            agent_tool_calls: python-call strings the agent emitted while
                answering the test question.
            agent_final_response: the agent's plain-text response. Compared
                against ``possible_answers``.
            possible_answers: list of acceptable substrings (per upstream's
                ``agentic_checker``).

        Returns ``(passed, details)``.
        """
        details: dict[str, object] = {
            "backend": backend,
            "scenario": scenario,
            "test_id": test_id,
            "agent_tool_calls": agent_tool_calls,
        }

        backend_class = f"MemoryAPI_{backend}"
        if backend_class not in CLASS_FILE_PATH_MAPPING:
            details["error"] = f"Unknown memory backend: {backend}"
            return False, details

        initial_config = {
            backend_class: {
                "scenario": scenario,
                "test_id": test_id,
                "test_category": f"memory_{backend}",
            }
        }

        try:
            runtime = ExecutableRuntime(
                involved_classes=[backend_class],
                initial_config=initial_config,
                memory_backend=backend,
            )
        except Exception as exc:
            details["error"] = f"Memory runtime init failed: {exc}"
            return False, details

        # Optionally pre-populate the memory with prereq messages. Each
        # message gets stored under a synthetic key so downstream searches
        # have something to hit. This isn't a real LLM-driven write phase
        # (upstream uses one); it's a lightweight deterministic surrogate
        # that gives the agent something to read in unit / CI runs.
        for i, msg in enumerate(prereq_messages or []):
            key = f"prereq_msg_{i:02d}"
            try:
                if backend == "rec_sum":
                    runtime.execute_calls(
                        [f"memory_append(text={msg!r})"]
                    )
                else:
                    runtime.execute_calls(
                        [f"core_memory_add(key={key!r}, value={msg!r})"]
                    )
            except Exception as exc:  # pragma: no cover — defensive
                details.setdefault("prereq_errors", []).append(str(exc))  # type: ignore[union-attr]

        # Execute the agent's tool calls against the prepared memory.
        try:
            tool_outputs = runtime.execute_calls(list(agent_tool_calls))
        except Exception as exc:
            details["error"] = f"Memory tool execution failed: {exc}"
            runtime.cleanup()
            return False, details

        details["tool_outputs"] = tool_outputs

        # Score: agentic_checker over the final response. Upstream concats
        # tool outputs into the response context implicitly; we mirror that
        # so a model that returned an empty assistant turn but exfiltrated
        # the answer via a tool result still passes (parity w/ upstream).
        scoring_text = "\n".join([agent_final_response or "", *tool_outputs])
        check = agentic_checker(scoring_text, possible_answers)
        details["agentic_check"] = check
        runtime.cleanup()
        return bool(check.get("valid", False)), details

    # ------------------------------------------------------------------
    # REST category scoring
    # ------------------------------------------------------------------
    def evaluate_rest(
        self,
        *,
        spec: RESTCallSpec,
        expected: object,
        runner: Optional[RESTRunner] = None,
    ) -> tuple[bool, dict[str, object]]:
        """Execute a REST call and compare the response against the upstream
        expected output.

        Honors ``self.enable_network``: if False, raises
        :class:`RuntimeNetworkRequired` so the runner can map the test to
        ``SKIPPED_NO_CREDENTIALS`` — matching the gating behavior for the
        web_search and multi-turn-with-WebSearchAPI categories.

        Returns ``(passed, details)``.

        Raises :class:`RESTRateLimited` on HTTP 429 so the caller can map
        it to ``SKIPPED_RATE_LIMITED``.
        """
        if not self.enable_network:
            raise RuntimeNetworkRequired(
                "REST execution requires enable_network=True"
            )

        rest_runner = runner or RESTRunner(
            enable_network=True,
            timeout_seconds=self.timeout_ms / 1000.0,
        )
        try:
            response = rest_runner.execute(spec)
        except RESTRateLimited:
            raise
        except RESTExecutionError as exc:
            return False, {"error": str(exc)}

        details: dict[str, object] = {
            "status_code": response.status_code,
            "elapsed_seconds": response.elapsed_seconds,
            "response_preview": response.text[:512],
        }
        passed = (
            200 <= response.status_code < 300
            and response.matches(expected)
        )
        details["expected_matched"] = passed
        return passed, details

    # ------------------------------------------------------------------
    # Legacy single-call execution (only used by unit tests now).
    # The old "register mocks from definitions" auto-success path is gone.
    # ------------------------------------------------------------------
    def register_mock(self, name: str, handler: MockHandler) -> None:
        """Register a single user-supplied handler. No auto-success."""
        self.registry.register(name, handler)

    def setup_standard_mocks(self) -> None:
        """No-op shim retained for back-compat with the previous evaluator.

        The synthetic always-success behavior is removed. Tests that need
        specific handlers should register them explicitly via
        ``register_mock``.
        """
        return None

    def register_mocks_from_definitions(
        self,
        definitions: list[FunctionDefinition],  # noqa: ARG002 — kept for ABI
    ) -> None:
        """No-op (was the broken always-success mock generator).

        Kept so callers don't immediately break, but does NOT register
        anything. The exec evaluator now drives the real upstream
        executable runtime.
        """
        return None

    async def execute(
        self,
        call: FunctionCall,
    ) -> tuple[bool, object, Optional[str]]:
        """Execute a single user-registered mock call. Returns
        ``(False, None, "unsupported")`` if the function isn't registered —
        we no longer fabricate a success."""
        preconfigured = self.registry.get_result(call.name)
        if preconfigured is not None:
            return True, preconfigured, None

        handler = self.registry.get_handler(call.name)
        if handler is None:
            return False, None, f"No mock handler for function: {call.name}"

        try:
            timeout_seconds = self.timeout_ms / 1000
            safe_args = self._prepare_arguments_for_execution(call.arguments)
            result = handler(**safe_args)
            if asyncio.iscoroutine(result):
                result = await asyncio.wait_for(result, timeout=timeout_seconds)
            return True, result, None
        except asyncio.TimeoutError:
            return False, None, f"Execution timeout for {call.name}"
        except TypeError as e:
            return False, None, f"Argument error for {call.name}: {e}"
        except Exception as e:
            return False, None, f"Execution error for {call.name}: {e}"

    def _prepare_arguments_for_execution(
        self,
        arguments: dict[str, ArgumentValue],
    ) -> dict[str, str | int | float | bool | list[object] | dict[str, object]]:
        prepared: dict[str, str | int | float | bool | list[object] | dict[str, object]] = {}
        for key, value in arguments.items():
            prepared[key] = self._convert_argument_value(value)
        return prepared

    def _convert_argument_value(
        self,
        value: ArgumentValue,
    ) -> str | int | float | bool | list[object] | dict[str, object]:
        if value is None:
            return ""
        if isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [self._convert_argument_value(v) for v in value]
        if isinstance(value, dict):
            return {k: self._convert_argument_value(v) for k, v in value.items()}
        return str(value)

    async def execute_all(
        self,
        calls: list[FunctionCall],
    ) -> tuple[bool, list[object], list[str]]:
        """Execute a list of user-registered mock calls (legacy path)."""
        results: list[object] = []
        errors: list[str] = []
        all_success = True

        for call in calls:
            success, result, error = await self.execute(call)
            results.append(result)
            if error:
                errors.append(error)
            if not success:
                all_success = False
                if not self.allow_partial_execution:
                    break

        return all_success, results, errors


__all__ = [
    "EXEC_SUPPORTED_CATEGORIES",
    "ExecutionEvaluator",
    "MockFunctionRegistry",
    "RuntimeNetworkRequired",
]
