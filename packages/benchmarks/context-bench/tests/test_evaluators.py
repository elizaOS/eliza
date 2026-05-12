"""Tests for evaluators."""


from elizaos_context_bench.evaluators.position import PositionAnalyzer
from elizaos_context_bench.evaluators.retrieval import RetrievalEvaluator
from elizaos_context_bench.types import (
    ContextBenchResult,
    ContextBenchType,
    NeedlePosition,
)


class TestRetrievalEvaluator:
    """Tests for RetrievalEvaluator class."""

    def test_evaluator_initialization(self) -> None:
        """Test evaluator initialization."""
        evaluator = RetrievalEvaluator()
        assert evaluator.semantic_threshold == 0.8

    def test_normalize_text(self) -> None:
        """Test text normalization."""
        evaluator = RetrievalEvaluator()

        # Basic normalization
        assert evaluator.normalize_text("HELLO") == "hello"
        assert evaluator.normalize_text("  hello  world  ") == "hello world"

        # Remove punctuation
        assert evaluator.normalize_text("Hello, World!") == "hello world"

        # Normalization handles prefixes
        normalized = evaluator.normalize_text("The answer is 42")
        assert "42" in normalized

    def test_exact_match(self) -> None:
        """Test exact match evaluation."""
        evaluator = RetrievalEvaluator()

        # Exact match
        assert evaluator.evaluate_exact_match("XYZ", "XYZ") is True

        # Case insensitive
        assert evaluator.evaluate_exact_match("xyz", "XYZ") is True

        # With normalization
        assert evaluator.evaluate_exact_match("The answer is XYZ", "XYZ") is True

        # No match
        assert evaluator.evaluate_exact_match("ABC", "XYZ") is False

    def test_contains(self) -> None:
        """Test contains evaluation."""
        evaluator = RetrievalEvaluator()

        assert evaluator.evaluate_contains("The secret code is XYZ123", "XYZ123") is True
        assert evaluator.evaluate_contains("xyz123", "XYZ123") is True
        assert evaluator.evaluate_contains("ABC", "XYZ") is False

    def test_fuzzy_match(self) -> None:
        """Test fuzzy matching."""
        evaluator = RetrievalEvaluator()

        # Exact should have high score
        is_match, score = evaluator.evaluate_fuzzy_match("hello", "hello")
        assert is_match is True
        assert score == 1.0

        # Similar should match
        is_match, score = evaluator.evaluate_fuzzy_match("hello world", "hello wrld")
        assert score > 0.8

        # Very different should not match
        is_match, score = evaluator.evaluate_fuzzy_match("abc", "xyz")
        assert is_match is False
        assert score < 0.5

    def test_semantic_similarity_fallback(self) -> None:
        """Test semantic similarity fallback to fuzzy matching."""
        evaluator = RetrievalEvaluator()  # No embedding function

        # Should fallback to fuzzy matching
        score = evaluator.evaluate_semantic_similarity("hello world", "hello world")
        assert score == 1.0

        score = evaluator.evaluate_semantic_similarity("hello", "goodbye")
        assert score < 0.5

    def test_contains_needle(self) -> None:
        """Test needle information detection."""
        evaluator = RetrievalEvaluator()

        # Money amounts
        assert evaluator.evaluate_contains_needle(
            "The budget was $47 million",
            "The total budget allocated was exactly $47 million."
        ) is True

        # Percentages
        assert evaluator.evaluate_contains_needle(
            "The success rate was 73%",
            "The medication showed a 73% success rate."
        ) is True

        # Names
        assert evaluator.evaluate_contains_needle(
            "Dr. Sarah Mitchell led the project",
            "Dr. Sarah Mitchell was appointed as the new CTO."
        ) is True

    def test_comprehensive_evaluation(self) -> None:
        """Test comprehensive evaluation."""
        evaluator = RetrievalEvaluator()

        result = evaluator.evaluate(
            predicted="The answer is XYZ123",
            expected="XYZ123",
            needle="The secret code is XYZ123."
        )

        assert "exact_match" in result
        assert "contains_answer" in result
        assert "fuzzy_match" in result
        assert "fuzzy_score" in result
        assert "semantic_similarity" in result
        assert "retrieval_success" in result
        assert "contains_needle_info" in result

        assert result["retrieval_success"] is True


class TestPositionAnalyzer:
    """Tests for PositionAnalyzer class."""

    def _create_result(
        self,
        task_id: str,
        position: NeedlePosition,
        context_length: int,
        success: bool,
    ) -> ContextBenchResult:
        """Helper to create a result."""
        return ContextBenchResult(
            task_id=task_id,
            bench_type=ContextBenchType.NIAH_BASIC,
            context_length=context_length,
            needle_position=position,
            actual_position_pct=50.0,
            predicted_answer="test",
            expected_answer="test" if success else "other",
            exact_match=success,
            semantic_similarity=1.0 if success else 0.0,
            retrieval_success=success,
            latency_ms=100.0,
            tokens_processed=context_length,
        )

    def test_analyzer_initialization(self) -> None:
        """Test analyzer initialization."""
        analyzer = PositionAnalyzer()
        assert len(analyzer.results) == 0

    def test_add_results(self) -> None:
        """Test adding results."""
        analyzer = PositionAnalyzer()
        results = [
            self._create_result("1", NeedlePosition.START, 1000, True),
            self._create_result("2", NeedlePosition.MIDDLE, 1000, False),
        ]
        analyzer.add_results(results)
        assert len(analyzer.results) == 2

    def test_calculate_position_accuracy(self) -> None:
        """Test position accuracy calculation."""
        results = [
            self._create_result("1", NeedlePosition.START, 1000, True),
            self._create_result("2", NeedlePosition.START, 1000, True),
            self._create_result("3", NeedlePosition.MIDDLE, 1000, False),
            self._create_result("4", NeedlePosition.MIDDLE, 1000, False),
            self._create_result("5", NeedlePosition.END, 1000, True),
        ]

        analyzer = PositionAnalyzer(results)
        accuracies = analyzer.calculate_position_accuracy()

        assert NeedlePosition.START in accuracies
        assert accuracies[NeedlePosition.START].accuracy == 1.0
        assert accuracies[NeedlePosition.START].total_tasks == 2

        assert NeedlePosition.MIDDLE in accuracies
        assert accuracies[NeedlePosition.MIDDLE].accuracy == 0.0

        assert NeedlePosition.END in accuracies
        assert accuracies[NeedlePosition.END].accuracy == 1.0

    def test_calculate_length_accuracy(self) -> None:
        """Test length accuracy calculation."""
        results = [
            self._create_result("1", NeedlePosition.MIDDLE, 1000, True),
            self._create_result("2", NeedlePosition.MIDDLE, 1000, True),
            self._create_result("3", NeedlePosition.MIDDLE, 4000, True),
            self._create_result("4", NeedlePosition.MIDDLE, 4000, False),
        ]

        analyzer = PositionAnalyzer(results)
        accuracies = analyzer.calculate_length_accuracy()

        # 1000 tokens should bucket to 1024
        assert 1024 in accuracies
        assert accuracies[1024].accuracy == 1.0

        # 4000 tokens should bucket to 4096
        assert 4096 in accuracies
        assert accuracies[4096].accuracy == 0.5

    def test_detect_lost_in_middle(self) -> None:
        """Test lost in middle detection."""
        # Create results showing lost in middle effect
        results = [
            # Good at start
            self._create_result("1", NeedlePosition.START, 1000, True),
            self._create_result("2", NeedlePosition.START, 1000, True),
            # Bad in middle
            self._create_result("3", NeedlePosition.MIDDLE, 1000, False),
            self._create_result("4", NeedlePosition.MIDDLE, 1000, False),
            # Good at end
            self._create_result("5", NeedlePosition.END, 1000, True),
            self._create_result("6", NeedlePosition.END, 1000, True),
        ]

        analyzer = PositionAnalyzer(results)
        has_effect, severity = analyzer.detect_lost_in_middle()

        assert has_effect is True
        assert severity == 1.0  # 100% drop (from 1.0 to 0.0)

    def test_no_lost_in_middle(self) -> None:
        """Test when there's no lost in middle effect."""
        results = [
            self._create_result("1", NeedlePosition.START, 1000, True),
            self._create_result("2", NeedlePosition.MIDDLE, 1000, True),
            self._create_result("3", NeedlePosition.END, 1000, True),
        ]

        analyzer = PositionAnalyzer(results)
        has_effect, severity = analyzer.detect_lost_in_middle()

        assert has_effect is False
        assert severity == 0.0

    def test_generate_position_heatmap(self) -> None:
        """Test heatmap generation."""
        results = [
            self._create_result("1", NeedlePosition.START, 1000, True),
            self._create_result("2", NeedlePosition.START, 4000, False),
            self._create_result("3", NeedlePosition.MIDDLE, 1000, True),
            self._create_result("4", NeedlePosition.MIDDLE, 4000, True),
        ]

        analyzer = PositionAnalyzer(results)
        heatmap, lengths, positions = analyzer.generate_position_heatmap()

        assert len(heatmap) > 0
        assert len(lengths) > 0
        assert len(positions) > 0

    def test_get_summary_stats(self) -> None:
        """Test summary statistics."""
        results = [
            self._create_result("1", NeedlePosition.START, 1000, True),
            self._create_result("2", NeedlePosition.MIDDLE, 1000, False),
        ]

        analyzer = PositionAnalyzer(results)
        stats = analyzer.get_summary_stats()

        assert stats["total_tasks"] == 2
        assert stats["correct_tasks"] == 1
        assert stats["overall_accuracy"] == 0.5
        assert "has_lost_in_middle_effect" in stats
        assert "context_degradation_rate" in stats
