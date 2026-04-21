"""Tests for GAIA metrics calculation."""

import pytest
from elizaos_gaia.types import (
    GAIALevel,
    ToolType,
    GAIAResult,
    LEADERBOARD_SCORES,
)
from elizaos_gaia.metrics import MetricsCalculator


class TestMetricsCalculator:
    """Tests for metrics calculation."""
    
    @pytest.fixture
    def calculator(self):
        """Create metrics calculator."""
        return MetricsCalculator()
    
    @pytest.fixture
    def sample_results(self) -> list[GAIAResult]:
        """Create sample results for testing."""
        return [
            GAIAResult(
                task_id="1",
                level=GAIALevel.LEVEL_1,
                question="Q1",
                predicted_answer="A1",
                expected_answer="A1",
                is_correct=True,
                tools_used=[ToolType.WEB_SEARCH],
                latency_ms=1000,
                token_usage=100,
            ),
            GAIAResult(
                task_id="2",
                level=GAIALevel.LEVEL_1,
                question="Q2",
                predicted_answer="Wrong",
                expected_answer="A2",
                is_correct=False,
                tools_used=[ToolType.WEB_SEARCH, ToolType.CALCULATOR],
                latency_ms=2000,
                token_usage=200,
            ),
            GAIAResult(
                task_id="3",
                level=GAIALevel.LEVEL_2,
                question="Q3",
                predicted_answer="A3",
                expected_answer="A3",
                is_correct=True,
                tools_used=[ToolType.CODE_EXEC],
                latency_ms=3000,
                token_usage=300,
            ),
            GAIAResult(
                task_id="4",
                level=GAIALevel.LEVEL_2,
                question="Q4",
                predicted_answer="",
                expected_answer="A4",
                is_correct=False,
                error="Timeout",
                latency_ms=5000,
                token_usage=0,
            ),
        ]


class TestOverallMetrics(TestMetricsCalculator):
    """Tests for overall metrics calculation."""
    
    def test_empty_results(self, calculator):
        """Test with empty results."""
        metrics = calculator.calculate([])
        assert metrics.overall_accuracy == 0.0
        assert metrics.total_questions == 0
    
    def test_accuracy(self, calculator, sample_results):
        """Test overall accuracy calculation."""
        metrics = calculator.calculate(sample_results)
        
        assert metrics.total_questions == 4
        assert metrics.correct_answers == 2
        assert metrics.overall_accuracy == 0.5
    
    def test_error_count(self, calculator, sample_results):
        """Test error counting."""
        metrics = calculator.calculate(sample_results)
        
        assert metrics.errors == 1  # One timeout error


class TestLevelMetrics(TestMetricsCalculator):
    """Tests for per-level metrics."""
    
    def test_level_breakdown(self, calculator, sample_results):
        """Test level breakdown."""
        metrics = calculator.calculate(sample_results)
        
        # Level 1: 2 questions, 1 correct
        assert metrics.level_counts[GAIALevel.LEVEL_1] == 2
        assert metrics.level_correct[GAIALevel.LEVEL_1] == 1
        assert metrics.level_accuracy[GAIALevel.LEVEL_1] == 0.5
        
        # Level 2: 2 questions, 1 correct
        assert metrics.level_counts[GAIALevel.LEVEL_2] == 2
        assert metrics.level_correct[GAIALevel.LEVEL_2] == 1
        assert metrics.level_accuracy[GAIALevel.LEVEL_2] == 0.5


class TestToolMetrics(TestMetricsCalculator):
    """Tests for tool usage metrics."""
    
    def test_tool_usage(self, calculator, sample_results):
        """Test tool usage counting."""
        metrics = calculator.calculate(sample_results)
        
        # Web search used twice
        assert metrics.tool_usage[ToolType.WEB_SEARCH] == 2
        
        # Calculator used once
        assert metrics.tool_usage[ToolType.CALCULATOR] == 1
        
        # Code exec used once
        assert metrics.tool_usage[ToolType.CODE_EXEC] == 1
    
    def test_tool_success_rate(self, calculator, sample_results):
        """Test tool success rate."""
        metrics = calculator.calculate(sample_results)
        
        # Web search: 1 success, 1 failure (50%)
        assert metrics.tool_success_rate[ToolType.WEB_SEARCH] == 0.5
        
        # Code exec: 1 success (100%)
        assert metrics.tool_success_rate[ToolType.CODE_EXEC] == 1.0


class TestPerformanceMetrics(TestMetricsCalculator):
    """Tests for performance metrics."""
    
    def test_latency(self, calculator, sample_results):
        """Test latency calculation."""
        metrics = calculator.calculate(sample_results)
        
        # Total: 1000 + 2000 + 3000 + 5000 = 11000
        # Average: 11000 / 4 = 2750
        assert metrics.avg_latency_ms == 2750
    
    def test_token_usage(self, calculator, sample_results):
        """Test token usage calculation."""
        metrics = calculator.calculate(sample_results)
        
        # Total: 100 + 200 + 300 + 0 = 600
        assert metrics.total_tokens == 600
        assert metrics.avg_tokens_per_question == 150


class TestLeaderboardComparison(TestMetricsCalculator):
    """Tests for leaderboard comparison."""
    
    def test_comparison(self, calculator, sample_results):
        """Test leaderboard comparison."""
        metrics = calculator.calculate(sample_results)
        comparison = calculator.compare_with_leaderboard(metrics)
        
        assert comparison.our_score == 0.5
        assert comparison.rank >= 1
        assert comparison.total_entries > 0
        assert "ElizaOS Agent" in comparison.comparison
    
    def test_custom_leaderboard(self, calculator, sample_results):
        """Test with custom leaderboard."""
        metrics = calculator.calculate(sample_results)
        
        custom_leaderboard = {
            "Model A": {"overall": 0.6, "level_1": 0.7, "level_2": 0.5, "level_3": 0.4},
            "Model B": {"overall": 0.4, "level_1": 0.5, "level_2": 0.3, "level_3": 0.2},
        }
        
        comparison = calculator.compare_with_leaderboard(metrics, custom_leaderboard)
        
        # Our score (0.5) is between Model A (0.6) and Model B (0.4)
        assert comparison.rank == 2


class TestAnalysisGeneration(TestMetricsCalculator):
    """Tests for analysis generation."""
    
    def test_analysis_keys(self, calculator, sample_results):
        """Test analysis contains expected keys."""
        metrics = calculator.calculate(sample_results)
        analysis = calculator.generate_analysis(metrics)
        
        assert "key_findings" in analysis
        assert "strengths" in analysis
        assert "weaknesses" in analysis
        assert "recommendations" in analysis
    
    def test_analysis_content(self, calculator, sample_results):
        """Test analysis has content."""
        metrics = calculator.calculate(sample_results)
        analysis = calculator.generate_analysis(metrics)
        
        # Should have at least some findings
        assert len(analysis["key_findings"]) > 0
