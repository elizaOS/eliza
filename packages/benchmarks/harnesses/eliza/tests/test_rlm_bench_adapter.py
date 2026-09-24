"""Unit tests for the rlm-bench adapter's answer extraction.

Pure-Python, no live server. The agent-driven bench server surfaces the
planner's answer in the captured tool call (`BENCHMARK_ACTION.arguments.answer`)
while `response.text` is often a generic ack or the "Sorry, something went
wrong." error fallback — so reading `params["answer"]`/`response.text` alone
misses the answer and tanks the score.
"""

from __future__ import annotations

from eliza_adapter.rlm_bench import _answer_from_action, _extract_answer


def test_prefers_captured_action_over_error_text() -> None:
    params = {
        "BENCHMARK_ACTION": {
            "command": "answer",
            "arguments": {"answer": "CRIMSON-ORCHID-42"},
        }
    }
    # Exactly the live failure mode: text is the error fallback.
    assert (
        _extract_answer("Sorry, something went wrong. Please try again.", params)
        == "CRIMSON-ORCHID-42"
    )


def test_answer_from_action_helper() -> None:
    assert (
        _answer_from_action(
            {"BENCHMARK_ACTION": {"arguments": {"answer": " 42 "}}}
        )
        == "42"
    )
    assert _answer_from_action({}) is None
    assert _answer_from_action({"BENCHMARK_ACTION": "nope"}) is None
    assert _answer_from_action({"BENCHMARK_ACTION": {"arguments": {}}}) is None
    assert (
        _answer_from_action({"BENCHMARK_ACTION": {"arguments": {"answer": "  "}}})
        is None
    )


def test_legacy_answer_param_still_works() -> None:
    assert _extract_answer("ignored", {"answer": "hello"}) == "hello"


def test_answer_tag_in_text_still_works() -> None:
    assert _extract_answer("blah <answer>Paris</answer> blah", {}) == "Paris"


def test_plain_text_fallback() -> None:
    assert _extract_answer("just the answer", {}) == "just the answer"


def test_empty() -> None:
    assert _extract_answer("", {}) == ""
