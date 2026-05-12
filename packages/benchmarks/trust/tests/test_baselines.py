"""Baseline validation tests.

Three handlers are tested:
1. PerfectHandler — ground truth oracle, MUST score 100% (validates scoring)
2. RandomHandler  — coin flip, MUST score poorly (validates discrimination)

If Perfect doesn't get 100%, the benchmark framework has a bug.
If Random gets high scores, the benchmark isn't discriminating.
"""

import warnings

from elizaos_trust_bench.baselines import PerfectHandler, RandomHandler
from elizaos_trust_bench.corpus import TEST_CORPUS
from elizaos_trust_bench.runner import TrustBenchmarkRunner
from elizaos_trust_bench.scorer import score_results
from elizaos_trust_bench.types import BenchmarkConfig, DetectionResult, ThreatCategory


def _run_handler(handler: object) -> list[DetectionResult]:
    """Run a handler through the full corpus and return raw detections."""
    runner = TrustBenchmarkRunner(BenchmarkConfig())
    return runner._run_all(handler, TEST_CORPUS)


# ===========================================================================
# PERFECT HANDLER — must score 100% on everything
# ===========================================================================


class TestPerfectHandler:
    """The perfect handler uses ground truth, so it MUST score perfectly.
    If it doesn't, the benchmark scoring logic is broken.
    """

    def test_perfect_overall_f1(self) -> None:
        """Perfect handler should achieve F1 = 1.0."""
        handler = PerfectHandler()
        detections = _run_handler(handler)
        result = score_results(TEST_CORPUS, detections, handler.name)
        assert result.overall_f1 == 1.0, (
            f"Perfect handler F1 should be 1.0, got {result.overall_f1:.3f}"
        )

    def test_perfect_zero_false_positives(self) -> None:
        """Perfect handler should have 0% false positive rate."""
        handler = PerfectHandler()
        detections = _run_handler(handler)
        result = score_results(TEST_CORPUS, detections, handler.name)
        assert result.false_positive_rate == 0.0, (
            f"Perfect handler FP rate should be 0.0, got {result.false_positive_rate:.3f}"
        )

    def test_perfect_all_categories(self) -> None:
        """Perfect handler should have F1=1.0 for every detection category."""
        handler = PerfectHandler()
        detections = _run_handler(handler)
        result = score_results(TEST_CORPUS, detections, handler.name)

        for cat_score in result.categories:
            if cat_score.total == 0:
                continue
            if cat_score.category == ThreatCategory.BENIGN:
                # Benign should have 0 FP
                assert cat_score.false_positives == 0, (
                    f"Perfect handler has {cat_score.false_positives} FP in benign"
                )
            else:
                assert cat_score.f1 == 1.0, (
                    f"Perfect handler {cat_score.category.value} F1 should be 1.0, "
                    f"got {cat_score.f1:.3f}"
                )

    def test_perfect_difficulty_breakdown(self) -> None:
        """Perfect handler should get 100% at every difficulty level."""
        handler = PerfectHandler()
        detections = _run_handler(handler)
        result = score_results(TEST_CORPUS, detections, handler.name)
        db = result.difficulty_breakdown

        if db.easy_total > 0:
            assert db.easy_correct == db.easy_total, (
                f"Perfect handler easy: {db.easy_correct}/{db.easy_total}"
            )
        if db.medium_total > 0:
            assert db.medium_correct == db.medium_total, (
                f"Perfect handler medium: {db.medium_correct}/{db.medium_total}"
            )
        if db.hard_total > 0:
            assert db.hard_correct == db.hard_total, (
                f"Perfect handler hard: {db.hard_correct}/{db.hard_total}"
            )


# ===========================================================================
# RANDOM HANDLER — must score poorly
# ===========================================================================


class TestRandomHandler:
    """The random handler flips a coin. It should score poorly.
    Run multiple times to account for randomness.
    """

    def test_random_low_f1(self) -> None:
        """Random handler should have F1 well below 1.0.

        With 50% detection rate on imbalanced corpus, F1 should be << 1.0.
        Run 5 times and check average.
        """
        f1_scores: list[float] = []
        for _ in range(5):
            handler = RandomHandler()
            detections = _run_handler(handler)
            result = score_results(TEST_CORPUS, detections, handler.name)
            f1_scores.append(result.overall_f1)

        avg_f1 = sum(f1_scores) / len(f1_scores)
        assert avg_f1 < 0.85, (
            f"Random handler average F1 should be < 0.85, got {avg_f1:.3f}"
        )

    def test_random_has_false_positives(self) -> None:
        """Random handler should produce some false positives.

        With 50% detection rate, ~50% of benign cases should be flagged.
        Run 5 times and check that at least one trial has FP > 0.
        """
        any_fp = False
        for _ in range(5):
            handler = RandomHandler()
            detections = _run_handler(handler)
            result = score_results(TEST_CORPUS, detections, handler.name)
            if result.false_positive_rate > 0:
                any_fp = True
                break

        assert any_fp, "Random handler should produce false positives in 5 trials"

    def test_random_misses_some_malicious(self) -> None:
        """Random handler should miss some malicious cases.

        Run 5 times and check that at least one trial has recalls < 1.0
        for some detection category.
        """
        any_miss = False
        for _ in range(5):
            handler = RandomHandler()
            detections = _run_handler(handler)
            result = score_results(TEST_CORPUS, detections, handler.name)

            for cat in result.categories:
                if cat.category != ThreatCategory.BENIGN and cat.total > 0:
                    if cat.recall < 1.0:
                        any_miss = True
                        break
            if any_miss:
                break

        assert any_miss, "Random handler should miss malicious cases in 5 trials"


# ===========================================================================
# COMPARATIVE — perfect >> random
# ===========================================================================


class TestComparative:
    """Verify that perfect handler significantly outperforms random."""

    def test_perfect_beats_random(self) -> None:
        """Perfect handler F1 should always exceed random handler F1."""
        perfect = PerfectHandler()
        perfect_det = _run_handler(perfect)
        perfect_result = score_results(TEST_CORPUS, perfect_det, perfect.name)

        # Average random over 3 trials
        random_f1s: list[float] = []
        for _ in range(3):
            rand = RandomHandler()
            rand_det = _run_handler(rand)
            rand_result = score_results(TEST_CORPUS, rand_det, rand.name)
            random_f1s.append(rand_result.overall_f1)

        avg_random_f1 = sum(random_f1s) / len(random_f1s)

        assert perfect_result.overall_f1 > avg_random_f1, (
            f"Perfect ({perfect_result.overall_f1:.3f}) should > "
            f"Random avg ({avg_random_f1:.3f})"
        )


# ===========================================================================
# BROKEN HANDLER — validates error handling works
# ===========================================================================


class _BrokenHandler:
    """Handler that raises exceptions — tests runner error resilience."""

    @property
    def name(self) -> str:
        return "broken"

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        raise RuntimeError("Intentional test failure")

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        return {"detected": True}  # Missing 'confidence' key

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        return "not a dict"  # type: ignore[return-value]  # Wrong return type

    def detect_impersonation(
        self, username: str, existing_users: list[str]
    ) -> dict[str, bool | float]:
        return {"detected": False, "confidence": 999.0}  # Out of range


class _EmptyHandler:
    """Handler with no detection methods — tests missing method warnings."""

    @property
    def name(self) -> str:
        return "empty"


class TestBrokenHandler:
    """Verify the runner handles broken handlers gracefully."""

    def test_broken_handler_doesnt_crash(self) -> None:
        """Runner should NOT crash when a handler raises exceptions."""
        handler = _BrokenHandler()
        runner = TrustBenchmarkRunner(BenchmarkConfig())
        # Should complete without raising
        detections = runner._run_all(handler, TEST_CORPUS)
        assert len(detections) == len(TEST_CORPUS)

    def test_broken_handler_produces_results(self) -> None:
        """Even broken handlers should produce detection results (defaulting to not-detected)."""
        handler = _BrokenHandler()
        runner = TrustBenchmarkRunner(BenchmarkConfig())
        detections = runner._run_all(handler, TEST_CORPUS)
        result = score_results(TEST_CORPUS, detections, handler.name)
        # Should have a valid F1 (not NaN or error)
        assert 0.0 <= result.overall_f1 <= 1.0

    def test_empty_handler_warns_about_missing_methods(self) -> None:
        """Empty handler should trigger warnings about missing methods."""
        handler = _EmptyHandler()
        runner = TrustBenchmarkRunner(BenchmarkConfig())
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            runner.run(handler)

        warning_texts = [str(w.message) for w in caught]
        assert any("missing methods" in t for t in warning_texts), (
            f"Expected 'missing methods' warning, got: {warning_texts}"
        )

    def test_empty_corpus_filter_warns(self) -> None:
        """Filtering to zero cases should produce a warning."""
        handler = PerfectHandler()
        config = BenchmarkConfig(tags=["nonexistent_tag_xyz"])
        runner = TrustBenchmarkRunner(config)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = runner.run(handler)

        assert result.total_tests == 0
        warning_texts = [str(w.message) for w in caught]
        assert any("empty" in t.lower() for t in warning_texts), (
            f"Expected empty corpus warning, got: {warning_texts}"
        )
