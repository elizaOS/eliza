"""Tests for the vendored BFCL executable runtime.

Verifies that:
  * The runtime actually invokes upstream BFCL tool implementations.
  * Network-gated classes raise RuntimeNetworkRequired by default.
  * decode_python_calls extracts upstream-canonical call lists from
    fenced / wrapped model output.
  * State comparison drives multi-turn scoring.
"""
from __future__ import annotations

import pytest

from benchmarks.bfcl.evaluators import ExecutionEvaluator
from benchmarks.bfcl.executable_runtime import (
    ExecutableRuntime,
    RuntimeNetworkRequired,
    decode_python_calls,
)


class TestExecutableRuntime:
    def test_math_api_stateless_execution(self) -> None:
        """MathAPI is stateless and should compute mean correctly."""
        rt = ExecutableRuntime(involved_classes=["MathAPI"], initial_config={})
        results = rt.execute_calls(["mean(numbers=[1.0, 2.0, 3.0])"])
        assert len(results) == 1
        assert '"result": 2.0' in results[0]

    def test_network_gated_class_raises_by_default(self) -> None:
        """WebSearchAPI requires network and must NOT silently succeed."""
        with pytest.raises(RuntimeNetworkRequired):
            ExecutableRuntime(
                involved_classes=["WebSearchAPI"],
                initial_config={},
                enable_network=False,
            )

    def test_forbidden_call_rejected(self) -> None:
        """Defense-in-depth: forbidden builtin names raise even when
        nothing is in scope to actually execute them."""
        rt = ExecutableRuntime(involved_classes=["MathAPI"], initial_config={})
        results = rt.execute_calls(["popen('whoami')"])
        assert len(results) == 1
        assert "Error during execution" in results[0]

    def test_decode_python_calls_plain_list(self) -> None:
        assert decode_python_calls("[ls(a=True), MathAPI.mean(numbers=[1,2])]") == [
            "ls(a=True)", "MathAPI.mean(numbers=[1,2])"
        ]

    def test_decode_python_calls_code_fence(self) -> None:
        text = "```python\n[mean(numbers=[1, 2, 3])]\n```"
        assert decode_python_calls(text) == ["mean(numbers=[1, 2, 3])"]

    def test_decode_python_calls_returns_empty_on_garbage(self) -> None:
        assert decode_python_calls("no calls here, sorry") == []
        assert decode_python_calls("") == []


class TestExecutionEvaluatorMultiTurn:
    def test_multi_turn_state_match(self) -> None:
        """Identical predicted and ground-truth trajectories must score
        as exec_success=True."""
        evaluator = ExecutionEvaluator()
        cfg = {
            "GorillaFileSystem": {
                "root": {
                    "alex": {
                        "type": "directory",
                        "contents": {
                            "log.txt": {"type": "file", "content": "hello"}
                        },
                    }
                }
            }
        }
        success, details = evaluator.evaluate_multi_turn(
            predicted_per_turn=[["ls()"]],
            ground_truth_per_turn=[["ls()"]],
            involved_classes=["GorillaFileSystem"],
            initial_config=cfg,
        )
        assert success is True
        assert details["state_match"] is True

    def test_multi_turn_state_mismatch(self) -> None:
        """Divergent trajectories (one mutates state, the other doesn't)
        must score as exec_success=False."""
        evaluator = ExecutionEvaluator()
        cfg = {
            "GorillaFileSystem": {
                "root": {
                    "alex": {
                        "type": "directory",
                        "contents": {
                            "log.txt": {"type": "file", "content": "hello"}
                        },
                    }
                }
            }
        }
        success, _details = evaluator.evaluate_multi_turn(
            # Model only lists; ground-truth creates a new file.
            predicted_per_turn=[["ls()"]],
            ground_truth_per_turn=[["touch(file_name='new.txt')"]],
            involved_classes=["GorillaFileSystem"],
            initial_config=cfg,
        )
        assert success is False
