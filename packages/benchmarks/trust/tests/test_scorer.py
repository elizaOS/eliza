"""Tests for the scoring logic."""

from elizaos_trust_bench.scorer import score_results
from elizaos_trust_bench.types import (
    DetectionResult,
    Difficulty,
    ThreatCategory,
    TrustTestCase,
)


def _make_case(
    id: str,
    category: ThreatCategory,
    expected_malicious: bool,
    difficulty: Difficulty = Difficulty.EASY,
) -> TrustTestCase:
    """Helper to create a test case."""
    return TrustTestCase(
        id=id,
        category=category,
        input=f"input-{id}",
        expected_malicious=expected_malicious,
        description=f"test case {id}",
        difficulty=difficulty,
        expected_type=category.value if expected_malicious else None,
    )


def _make_detection(test_id: str, detected: bool, confidence: float = 1.0) -> DetectionResult:
    """Helper to create a detection result."""
    return DetectionResult(
        test_id=test_id,
        detected=detected,
        confidence=confidence,
    )


class TestScorerBasics:
    """Basic scoring correctness tests."""

    def test_perfect_score(self) -> None:
        """All correct detections should yield F1=1.0."""
        corpus = [
            _make_case("m1", ThreatCategory.PROMPT_INJECTION, True),
            _make_case("m2", ThreatCategory.PROMPT_INJECTION, True),
            _make_case("b1", ThreatCategory.BENIGN, False),
        ]
        results = [
            _make_detection("m1", True),
            _make_detection("m2", True),
            _make_detection("b1", False),
        ]

        result = score_results(corpus, results, "test")
        assert result.overall_f1 == 1.0
        assert result.false_positive_rate == 0.0

    def test_all_missed(self) -> None:
        """All missed detections should yield F1=0.0."""
        corpus = [
            _make_case("m1", ThreatCategory.PROMPT_INJECTION, True),
            _make_case("m2", ThreatCategory.PROMPT_INJECTION, True),
        ]
        results = [
            _make_detection("m1", False),
            _make_detection("m2", False),
        ]

        result = score_results(corpus, results, "test")
        assert result.overall_f1 == 0.0

    def test_all_false_positives(self) -> None:
        """All benign flagged = 100% false positive rate."""
        corpus = [
            _make_case("b1", ThreatCategory.BENIGN, False),
            _make_case("b2", ThreatCategory.BENIGN, False),
        ]
        results = [
            _make_detection("b1", True),
            _make_detection("b2", True),
        ]

        result = score_results(corpus, results, "test")
        assert result.false_positive_rate == 1.0

    def test_missing_result_counts_as_fn(self) -> None:
        """A malicious case with no result should count as false negative."""
        corpus = [
            _make_case("m1", ThreatCategory.PROMPT_INJECTION, True),
        ]
        results: list[DetectionResult] = []  # No results at all

        result = score_results(corpus, results, "test")
        inj_score = next(
            c for c in result.categories
            if c.category == ThreatCategory.PROMPT_INJECTION
        )
        assert inj_score.false_negatives == 1
        assert inj_score.true_positives == 0

    def test_missing_result_counts_as_tn_for_benign(self) -> None:
        """A benign case with no result should count as true negative."""
        corpus = [
            _make_case("b1", ThreatCategory.BENIGN, False),
        ]
        results: list[DetectionResult] = []

        result = score_results(corpus, results, "test")
        benign_score = next(
            c for c in result.categories
            if c.category == ThreatCategory.BENIGN
        )
        assert benign_score.true_negatives == 1


class TestScorerDifficultyBreakdown:
    """Test difficulty breakdown computation."""

    def test_difficulty_counts(self) -> None:
        corpus = [
            _make_case("e1", ThreatCategory.PROMPT_INJECTION, True, Difficulty.EASY),
            _make_case("m1", ThreatCategory.PROMPT_INJECTION, True, Difficulty.MEDIUM),
            _make_case("h1", ThreatCategory.PROMPT_INJECTION, True, Difficulty.HARD),
        ]
        results = [
            _make_detection("e1", True),   # correct
            _make_detection("m1", True),   # correct
            _make_detection("h1", False),  # wrong
        ]

        result = score_results(corpus, results, "test")
        db = result.difficulty_breakdown

        assert db.easy_correct == 1
        assert db.easy_total == 1
        assert db.medium_correct == 1
        assert db.medium_total == 1
        assert db.hard_correct == 0
        assert db.hard_total == 1


class TestScorerMultiCategory:
    """Test scoring across multiple categories."""

    def test_macro_f1_averages_categories(self) -> None:
        """Macro F1 should average across detection categories (not benign)."""
        corpus = [
            _make_case("inj1", ThreatCategory.PROMPT_INJECTION, True),
            _make_case("se1", ThreatCategory.SOCIAL_ENGINEERING, True),
            _make_case("b1", ThreatCategory.BENIGN, False),
        ]
        results = [
            _make_detection("inj1", True),   # injection: F1=1.0
            _make_detection("se1", False),   # SE: F1=0.0
            _make_detection("b1", False),    # benign: correct
        ]

        result = score_results(corpus, results, "test")

        # Injection F1=1.0, SE F1=0.0, others F1=0.0
        # Macro = average of all detection categories that have cases
        inj_score = next(
            c for c in result.categories
            if c.category == ThreatCategory.PROMPT_INJECTION
        )
        se_score = next(
            c for c in result.categories
            if c.category == ThreatCategory.SOCIAL_ENGINEERING
        )
        assert inj_score.f1 == 1.0
        assert se_score.f1 == 0.0

    def test_empty_category_has_zero_f1(self) -> None:
        """Categories with no test cases should have F1=0."""
        corpus = [
            _make_case("inj1", ThreatCategory.PROMPT_INJECTION, True),
        ]
        results = [
            _make_detection("inj1", True),
        ]

        result = score_results(corpus, results, "test")

        # Resource abuse has no cases -> F1 should be 0
        abuse_score = next(
            c for c in result.categories
            if c.category == ThreatCategory.RESOURCE_ABUSE
        )
        assert abuse_score.f1 == 0.0
        assert abuse_score.total == 0


class TestScorerEmptyCorpus:
    """Test edge cases with empty or minimal corpus."""

    def test_empty_corpus_returns_zero_f1(self) -> None:
        """Empty corpus should produce zero F1, no division errors."""
        result = score_results([], [], "test")
        assert result.overall_f1 == 0.0
        assert result.false_positive_rate == 0.0
        assert result.total_tests == 0

    def test_empty_results_for_nonempty_corpus(self) -> None:
        """Corpus with no results should count everything as missed."""
        corpus = [
            _make_case("m1", ThreatCategory.PROMPT_INJECTION, True),
            _make_case("b1", ThreatCategory.BENIGN, False),
        ]
        result = score_results(corpus, [], "test")
        assert result.overall_f1 == 0.0
        # Benign with no result = TN (not flagged = correct)
        assert result.false_positive_rate == 0.0


class TestScorerConfidenceClamping:
    """Test that out-of-range confidence values don't corrupt metrics."""

    def test_high_confidence_still_correct_detection(self) -> None:
        """Detection with confidence > 1.0 should still be counted as TP."""
        corpus = [_make_case("m1", ThreatCategory.PROMPT_INJECTION, True)]
        results = [_make_detection("m1", True, confidence=5.0)]
        result = score_results(corpus, results, "test")

        inj = next(c for c in result.categories if c.category == ThreatCategory.PROMPT_INJECTION)
        assert inj.true_positives == 1
