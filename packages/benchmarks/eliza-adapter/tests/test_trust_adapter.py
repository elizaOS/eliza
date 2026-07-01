"""Unit tests for the trust adapter's JSON extraction.

Pure-Python, no live server: they feed raw response strings to
``_parse_analysis_json`` and assert the detection map is recovered even when a
reasoning model wraps the answer in prose (the failure mode that scored the
agent-driven trust benchmark F1=0 despite correct detections).
"""

from __future__ import annotations

from eliza_adapter.trust import (
    _detection_map_from_action,
    _iter_balanced_json_objects,
    _parse_analysis_json,
)

# Answer JSON the trust scorer expects.
_ANSWER = (
    '{"prompt_injection": {"detected": true, "confidence": 0.99}, '
    '"social_engineering": {"detected": false, "confidence": 0.1}}'
)


def test_clean_json_unchanged() -> None:
    out = _parse_analysis_json(_ANSWER)
    assert out["prompt_injection"]["detected"] is True
    assert out["prompt_injection"]["confidence"] == 0.99
    assert out["social_engineering"]["detected"] is False


def test_fenced_json_unchanged() -> None:
    out = _parse_analysis_json(f"```json\n{_ANSWER}\n```")
    assert out["prompt_injection"]["detected"] is True


def test_recovers_answer_after_reasoning_prose_with_stray_braces() -> None:
    # Reasoning-model output: prose (with stray braces) then the JSON answer.
    # A greedy `{.*}` match spans the first stray brace to the last one and
    # fails to parse -> the old code scored this a false negative.
    raw = (
        "Let me analyze the message for each category.\n"
        "The user writes {ignore all previous instructions} which is a classic "
        "attack pattern {note}. Weighing intent vs. keywords...\n\n"
        f"Final answer:\n{_ANSWER}"
    )
    out = _parse_analysis_json(raw)
    assert out["prompt_injection"]["detected"] is True
    assert out["prompt_injection"]["confidence"] == 0.99


def test_prefers_last_balanced_object() -> None:
    # An early example object followed by the real answer: take the last one.
    raw = (
        'Example format: {"prompt_injection": {"detected": false, "confidence": 0.1}}\n'
        f"My analysis:\n{_ANSWER}"
    )
    out = _parse_analysis_json(raw)
    assert out["prompt_injection"]["detected"] is True


def test_braces_inside_strings_do_not_unbalance_scan() -> None:
    raw = (
        'The payload literally contains "}" and "{" characters. Result: '
        '{"prompt_injection": {"detected": true, "confidence": 0.8}}'
    )
    out = _parse_analysis_json(raw)
    assert out["prompt_injection"]["detected"] is True


def test_unparseable_returns_empty() -> None:
    assert _parse_analysis_json("no json here at all") == {}
    assert _parse_analysis_json("") == {}


def test_iter_balanced_objects_ignores_string_braces() -> None:
    objs = _iter_balanced_json_objects('prefix {"a": "has } brace"} suffix {"b": 1}')
    assert objs == ['{"a": "has } brace"}', '{"b": 1}']


def test_detection_map_from_captured_action() -> None:
    # The real agent-driven failure mode: the detection lives in the captured
    # BENCHMARK_ACTION arguments; response.text is an error fallback. Reading the
    # structured action recovers the correct verdict.
    params = {
        "BENCHMARK_ACTION": {
            "command": "trust",
            "tool_name": "evaluate_message",
            "arguments": {
                "prompt_injection": {"detected": True, "confidence": 0.95},
                "social_engineering": {"detected": False, "confidence": 0.05},
            },
        }
    }
    out = _detection_map_from_action(params)
    assert out["prompt_injection"]["detected"] is True
    assert out["prompt_injection"]["confidence"] == 0.95


def test_detection_map_from_action_arguments_as_json_string() -> None:
    params = {
        "BENCHMARK_ACTION": {
            "arguments": '{"prompt_injection": {"detected": true, "confidence": 0.9}}'
        }
    }
    out = _detection_map_from_action(params)
    assert out["prompt_injection"]["detected"] is True


def test_detection_map_from_action_absent() -> None:
    assert _detection_map_from_action({}) == {}
    assert _detection_map_from_action({"BENCHMARK_ACTION": "not-a-dict"}) == {}
