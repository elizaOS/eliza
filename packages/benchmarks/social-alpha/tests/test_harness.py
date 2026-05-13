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
