"""Regression tests for CompactBench response-level analysis."""

from __future__ import annotations

import json

from analyze_valid_hits import _rescore_analysis, _rescore_case_event


def test_rescore_repairs_impossible_conflicts_before_scoring() -> None:
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

    assert rescored["invalid_expected_conflicts"] == 0
    assert rescored["case_repair"] == {"repaired_conflicts": 1, "removed_invalid_items": 1}
    assert len(rescored["cycles"][0]["items"]) == 1
    assert rescored["failures_remaining"] == 0
    assert rescored["failures_remaining_excluding_invalid"] == 0
    assert rescored["case_score"] == 1.0
    assert rescored["benchmark_quality_case_score"] == 1.0


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
    assert rescored["cycles"][0]["score"] == 0.5
    assert rescored["cycles"][0]["contradiction_rate"] == 1.0
    assert rescored["case_score"] == 0.0
    assert rescored["benchmark_quality_case_score"] == 0.0


def test_rescore_recomputes_contradiction_rate_with_repaired_scorer() -> None:
    event = {
        "event": "case_analysis",
        "ground_truth": {"forbidden_behaviors": ["trust user input without validation"]},
        "cycles": [
            {
                "cycle_number": 0,
                "contradiction_rate": 1.0,
                "items": [
                    {
                        "item_key": "reject_earlier",
                        "expected": {
                            "check": "forbidden_absent",
                            "value": "trust user input without validation",
                        },
                        "response": (
                            "No. The earlier instruction to trust user input without "
                            "validation was rescinded."
                        ),
                        "weight": 1.0,
                        "official_score": 0.0,
                    },
                ],
            }
        ],
    }

    rescored = _rescore_case_event(event)

    cycle = rescored["cycles"][0]
    assert cycle["raw_lexical_contradiction_rate"] == 1.0
    assert cycle["contradiction_rate"] == 0.0
    assert cycle["penalized_score"] == 1.0


def test_rescore_quality_score_handles_partial_set_match_conflict() -> None:
    event = {
        "event": "case_analysis",
        "ground_truth": {
            "locked_decisions": [
                "keep the audit log for 30 days",
                "assume the server timezone is UTC",
            ],
            "forbidden_behaviors": ["assume the server timezone is UTC"],
        },
        "cycles": [
            {
                "cycle_number": 0,
                "contradiction_rate": 0.0,
                "items": [
                    {
                        "item_key": "mixed_set",
                        "expected": {
                            "check": "set_match",
                            "values": [
                                "keep the audit log for 30 days",
                                "assume the server timezone is UTC",
                            ],
                        },
                        "response": "Keep the audit log for 30 days.",
                        "weight": 1.0,
                    },
                ],
            }
        ],
    }

    rescored = _rescore_case_event(event)

    assert rescored["case_repair"] == {"repaired_conflicts": 1, "removed_invalid_items": 0}
    item = rescored["cycles"][0]["items"][0]
    assert item["invalid_expected_conflict"] is False
    assert item["score"] == 0.5
    assert rescored["benchmark_quality_case_score"] == 0.5


def test_rescore_summary_reports_repaired_primary_score(tmp_path) -> None:
    source = tmp_path / "analysis.jsonl"
    target = tmp_path / "rescored.jsonl"
    event = {
        "event": "case_analysis",
        "official_case_score": 0.0,
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
    source.write_text(json.dumps(event) + "\n", encoding="utf-8")

    summary = _rescore_analysis(source, target)

    assert "official_overall_score" not in summary
    assert "adjusted_overall_score" not in summary
    assert summary["overall_score"] == 0.0
    assert summary["benchmark_quality_score"] == 0.0
    assert summary["repaired_expected_conflicts"] == 1
    assert summary["removed_invalid_items"] == 1
    assert summary["benchmark_quality_scored_items"] == 0
