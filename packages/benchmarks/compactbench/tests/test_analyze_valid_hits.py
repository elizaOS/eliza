"""Regression tests for CompactBench response-level analysis."""

from __future__ import annotations

from analyze_valid_hits import _rescore_case_event


def test_rescore_drops_impossible_conflicts_from_quality_score() -> None:
    event = {
        "event": "case_analysis",
        "ground_truth": {
            "locked_decisions": ["assume the server timezone is UTC"],
            "forbidden_behaviors": ["assume the server timezone is UTC"],
        },
        "cycles": [
            {
                "cycle_number": 0,
                "contradiction_rate": 0.0,
                "items": [
                    {
                        "item_key": "recall_latest_decision",
                        "expected": {
                            "check": "contains_normalized",
                            "value": "assume the server timezone is UTC",
                        },
                        "response": "Assume the server timezone is UTC.",
                        "weight": 1.0,
                    },
                    {
                        "item_key": "reject_earlier",
                        "expected": {
                            "check": "forbidden_absent",
                            "value": "assume the server timezone is UTC",
                        },
                        "response": "Assume the server timezone is UTC.",
                        "weight": 1.0,
                    },
                ],
            }
        ],
    }

    rescored = _rescore_case_event(event)

    assert rescored["invalid_expected_conflicts"] == 2
    assert rescored["failures_remaining"] == 1
    assert rescored["failures_remaining_excluding_invalid"] == 0
    assert rescored["adjusted_case_score"] == 0.5
    assert rescored["adjusted_case_score_excluding_invalid"] is None
    assert rescored["benchmark_quality_case_score"] is None


def test_rescore_quality_score_keeps_real_items() -> None:
    event = {
        "event": "case_analysis",
        "ground_truth": {
            "locked_decisions": ["ship the migration on Tuesday"],
            "forbidden_behaviors": ["assume the server timezone is UTC"],
        },
        "cycles": [
            {
                "cycle_number": 0,
                "contradiction_rate": 0.0,
                "items": [
                    {
                        "item_key": "valid_recall",
                        "expected": {
                            "check": "contains_normalized",
                            "value": "ship the migration on Tuesday",
                        },
                        "response": "Ship the migration on Tuesday.",
                        "weight": 1.0,
                    },
                    {
                        "item_key": "invalid_probe",
                        "expected": {
                            "check": "forbidden_absent",
                            "value": "assume the server timezone is UTC",
                        },
                        "response": "Assume the server timezone is UTC.",
                        "weight": 1.0,
                    },
                ],
            }
        ],
    }

    rescored = _rescore_case_event(event)

    assert rescored["invalid_expected_conflicts"] == 0
    assert rescored["adjusted_case_score"] == 0.5
    assert rescored["adjusted_case_score_excluding_invalid"] == 0.5
    assert rescored["benchmark_quality_case_score"] == 0.5
