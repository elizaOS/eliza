"""Regression tests for Social Alpha harness option handling."""

from benchmark import harness
from benchmark.suites.extract import ExtractResults


class _DummySystem:
    def reset(self) -> None:
        pass


def test_run_benchmark_normalizes_suite_names(monkeypatch) -> None:
    called = []

    def fake_extract_run(system, calls):
        called.append((system, calls))
        return ExtractResults(
            detection_precision=1.0,
            detection_recall=1.0,
            detection_f1=1.0,
            detection_accuracy=1.0,
            sentiment_macro_f1=1.0,
            sentiment_precision_buy=1.0,
            sentiment_recall_buy=1.0,
            sentiment_precision_sell=1.0,
            sentiment_recall_sell=1.0,
            conviction_kendall_tau=1.0,
            conviction_accuracy=1.0,
            token_extraction_accuracy=1.0,
            token_resolution_accuracy=1.0,
            suite_score=100.0,
        )

    monkeypatch.setattr(harness.ExtractSuite, "run", staticmethod(fake_extract_run))

    results = harness.run_benchmark(
        _DummySystem(),
        {"calls": [], "users": [], "tokens": []},
        suites=["EXTRACT"],
    )

    assert called
    assert results["EXTRACT"]["suite_score"] == 100.0


def test_expand_ground_truth_adds_ten_edge_calls_per_base() -> None:
    gt = {
        "calls": [
            {
                "call_id": "call-1",
                "message_id": "msg-1",
                "user_id": "user-1",
                "content": "Strong buy on $MOON",
                "token_address": "token_moon",
                "is_recommendation": True,
                "recommendation_type": "BUY",
                "conviction": "HIGH",
            }
        ],
        "users": [
            {
                "user_id": "user-1",
                "total_calls": 1,
                "call_ids": ["call-1"],
            }
        ],
        "tokens": [
            {
                "address": "token_moon",
                "call_count": 1,
            }
        ],
    }

    expanded = harness.expand_ground_truth(gt)

    assert harness.count_scenarios(gt, include_edge_scenarios=True) == {
        "base": 1,
        "edge": 10,
        "edge_multiplier": 10,
        "total": 11,
    }
    assert len(expanded["calls"]) == 11
    assert expanded["calls"][1]["base_call_id"] == "call-1"
    assert expanded["calls"][1]["scenario_id"]
    assert expanded["users"][0]["total_calls"] == 11
    assert expanded["tokens"][0]["call_count"] == 11
    harness.validate_scenarios(gt, include_edge_scenarios=True)
