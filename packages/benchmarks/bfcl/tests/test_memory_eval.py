"""Unit tests for the BFCL memory category evaluation path.

Covers:
  * Memory KV runtime constructs against an isolated snapshot dir and
    can be exercised via the standard ExecutableRuntime API.
  * Memory KV evaluation passes when the agent's response contains the
    expected substring (agentic_checker semantics).
  * Memory rec_sum evaluation passes when the model recalls appended text.
  * Memory vector evaluation falls back gracefully when ML deps missing
    (otherwise still scores correctly when deps are present).
  * Agentic checker handles whitespace/punctuation normalization.
"""
from __future__ import annotations

import pytest

from benchmarks.bfcl.evaluators import ExecutionEvaluator
from benchmarks.bfcl.executable_runtime import (
    MEMORY_BACKEND_CLASSES,
    ExecutableRuntime,
    agentic_checker,
    extract_memory_backend_type,
)


class TestAgenticChecker:
    def test_basic_substring_match(self) -> None:
        result = agentic_checker(
            "The answer is Paris.",
            ["Paris"],
        )
        assert result["valid"] is True

    def test_punctuation_normalization(self) -> None:
        result = agentic_checker(
            "Paris, France (Europe)",
            ["paris france europe"],
        )
        assert result["valid"] is True

    def test_no_match_returns_invalid(self) -> None:
        result = agentic_checker(
            "I don't know the answer.",
            ["Paris", "London"],
        )
        assert result["valid"] is False
        assert "details" in result

    def test_list_response_unwrap(self) -> None:
        # Some models emit list-wrapped strings; checker should unwrap.
        result = agentic_checker(["The Eiffel Tower is in Paris."], ["Paris"])
        assert result["valid"] is True

    def test_extract_memory_backend_type(self) -> None:
        assert extract_memory_backend_type("memory_kv") == "kv"
        assert extract_memory_backend_type("memory_vector") == "vector"
        assert extract_memory_backend_type("memory_rec_sum") == "rec_sum"
        with pytest.raises(ValueError):
            extract_memory_backend_type("simple")


class TestMemoryKVRuntime:
    def test_kv_runtime_constructs(self) -> None:
        """MemoryAPI_kv should construct via the standard runtime with
        an auto-provisioned snapshot tempdir."""
        rt = ExecutableRuntime(
            involved_classes=["MemoryAPI_kv"],
            initial_config={
                "MemoryAPI_kv": {
                    "scenario": "unit_test",
                    "test_id": "memory_kv_0-unit_test-0",
                }
            },
            memory_backend="kv",
        )
        assert "MemoryAPI_kv" in rt._instances
        instance = rt._instances["MemoryAPI_kv"]
        assert hasattr(instance, "core_memory")
        rt.cleanup()

    def test_kv_core_memory_add(self) -> None:
        """Exercising core_memory_add should mutate state visibly."""
        rt = ExecutableRuntime(
            involved_classes=["MemoryAPI_kv"],
            initial_config={
                "MemoryAPI_kv": {
                    "scenario": "unit_test",
                    "test_id": "memory_kv_0-unit_test-0",
                }
            },
            memory_backend="kv",
        )
        results = rt.execute_calls([
            "core_memory_add(key='favorite_color', value='blue')",
        ])
        assert len(results) == 1
        # Should NOT be an error
        assert "Error during execution" not in results[0]
        inst = rt._instances["MemoryAPI_kv"]
        assert "favorite_color" in inst.core_memory
        rt.cleanup()

    def test_generic_memoryapi_resolves_to_kv(self) -> None:
        """The fixture-supplied generic 'MemoryAPI' name should resolve
        to MemoryAPI_kv when no backend is specified."""
        rt = ExecutableRuntime(
            involved_classes=["MemoryAPI"],
            initial_config={
                "MemoryAPI_kv": {
                    "scenario": "unit_test",
                    "test_id": "memory_kv_0-unit_test-0",
                }
            },
            memory_backend="kv",
        )
        assert "MemoryAPI_kv" in rt._instances
        assert "MemoryAPI" not in rt._instances
        rt.cleanup()


class TestEvaluateMemory:
    def test_kv_eval_passes_when_response_matches(self) -> None:
        evaluator = ExecutionEvaluator()
        passed, details = evaluator.evaluate_memory(
            backend="kv",
            scenario="finance",
            test_id="memory_kv_0-finance-0",
            prereq_messages=["My name is Alex and I run a hedge fund."],
            agent_tool_calls=[],
            agent_final_response="Your name is Alex.",
            possible_answers=["Alex"],
        )
        assert passed is True
        assert details["backend"] == "kv"
        assert details["agentic_check"]["valid"] is True

    def test_kv_eval_fails_when_response_doesnt_match(self) -> None:
        evaluator = ExecutionEvaluator()
        passed, details = evaluator.evaluate_memory(
            backend="kv",
            scenario="finance",
            test_id="memory_kv_0-finance-0",
            prereq_messages=[],
            agent_tool_calls=[],
            agent_final_response="I don't know.",
            possible_answers=["Alex", "Pat"],
        )
        assert passed is False

    def test_kv_eval_with_tool_call_output_matches(self) -> None:
        """The agentic checker scores over response + tool outputs, so a
        tool that returned the answer should pass even with an empty
        assistant message."""
        evaluator = ExecutionEvaluator()
        passed, details = evaluator.evaluate_memory(
            backend="kv",
            scenario="finance",
            test_id="memory_kv_0-finance-0",
            # Seed memory with the answer so the tool call returns it.
            prereq_messages=["The CFO is Alex."],
            # core_memory_retrieve_all dumps the full memory back as a
            # dict — the substring "Alex" survives the json stringify.
            agent_tool_calls=["core_memory_retrieve_all()"],
            agent_final_response="",
            possible_answers=["Alex"],
        )
        # Tool output should contain "Alex" from the stored memory.
        assert passed is True
        assert details["tool_outputs"]

    def test_rec_sum_eval_passes_when_appended_text_recalled(self) -> None:
        evaluator = ExecutionEvaluator()
        passed, details = evaluator.evaluate_memory(
            backend="rec_sum",
            scenario="finance",
            test_id="memory_rec_sum_0-finance-0",
            prereq_messages=["I love sailing in the Mediterranean."],
            agent_tool_calls=[],
            agent_final_response="They love sailing in the Mediterranean.",
            possible_answers=["sailing"],
        )
        assert passed is True

    def test_vector_eval_falls_back_gracefully_when_deps_missing(self) -> None:
        """If sentence_transformers / faiss aren't installed, evaluate_memory
        must NOT crash — instead it returns (False, {"error": ...})."""
        try:
            import sentence_transformers  # noqa: F401
            import faiss  # noqa: F401
            pytest.skip("ML deps installed — graceful-fallback test n/a")
        except ImportError:
            pass

        evaluator = ExecutionEvaluator()
        passed, details = evaluator.evaluate_memory(
            backend="vector",
            scenario="finance",
            test_id="memory_vector_0-finance-0",
            prereq_messages=[],
            agent_tool_calls=[],
            agent_final_response="anything",
            possible_answers=["something"],
        )
        assert passed is False
        assert "error" in details


class TestMemoryBackendClassMap:
    def test_all_three_backends_registered(self) -> None:
        assert MEMORY_BACKEND_CLASSES == {
            "kv": "MemoryAPI_kv",
            "vector": "MemoryAPI_vector",
            "rec_sum": "MemoryAPI_rec_sum",
        }
