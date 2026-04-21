"""Tests for GAIA type definitions."""

import pytest
from elizaos_gaia.types import (
    GAIALevel,
    ToolType,
    GAIAQuestion,
    GAIAResult,
    GAIAMetrics,
    GAIAConfig,
    LEADERBOARD_SCORES,
)


class TestGAIALevel:
    """Tests for GAIALevel enum."""
    
    def test_level_values(self):
        """Test level enum values."""
        assert GAIALevel.LEVEL_1.value == "1"
        assert GAIALevel.LEVEL_2.value == "2"
        assert GAIALevel.LEVEL_3.value == "3"
    
    def test_level_from_string(self):
        """Test creating level from string."""
        assert GAIALevel("1") == GAIALevel.LEVEL_1
        assert GAIALevel("2") == GAIALevel.LEVEL_2
        assert GAIALevel("3") == GAIALevel.LEVEL_3


class TestToolType:
    """Tests for ToolType enum."""
    
    def test_tool_types_exist(self):
        """Test all expected tool types exist."""
        expected_tools = [
            "web_search", "web_browse", "file_read", "code_exec",
            "calculator", "image_analysis", "pdf_read", "spreadsheet_read",
        ]
        for tool in expected_tools:
            assert hasattr(ToolType, tool.upper())


class TestGAIAQuestion:
    """Tests for GAIAQuestion dataclass."""
    
    def test_create_question(self):
        """Test creating a GAIA question."""
        q = GAIAQuestion(
            task_id="test-001",
            question="What is 2 + 2?",
            level=GAIALevel.LEVEL_1,
            final_answer="4",
        )
        
        assert q.task_id == "test-001"
        assert q.question == "What is 2 + 2?"
        assert q.level == GAIALevel.LEVEL_1
        assert q.final_answer == "4"
        assert q.file_name is None
        assert q.required_tools == []
    
    def test_question_with_file(self):
        """Test question with attached file."""
        q = GAIAQuestion(
            task_id="test-002",
            question="Read the PDF and answer",
            level=GAIALevel.LEVEL_2,
            final_answer="answer",
            file_name="document.pdf",
        )
        
        assert q.file_name == "document.pdf"


class TestGAIAResult:
    """Tests for GAIAResult dataclass."""
    
    def test_create_result(self):
        """Test creating a result."""
        r = GAIAResult(
            task_id="test-001",
            level=GAIALevel.LEVEL_1,
            question="What is 2 + 2?",
            predicted_answer="4",
            expected_answer="4",
            is_correct=True,
        )
        
        assert r.is_correct
        assert r.error is None
        assert r.tools_used == []
    
    def test_incorrect_result(self):
        """Test incorrect result."""
        r = GAIAResult(
            task_id="test-002",
            level=GAIALevel.LEVEL_1,
            question="What is 2 + 2?",
            predicted_answer="5",
            expected_answer="4",
            is_correct=False,
        )
        
        assert not r.is_correct


class TestGAIAConfig:
    """Tests for GAIAConfig."""
    
    def test_default_config(self):
        """Test default configuration."""
        config = GAIAConfig()
        
        assert config.split == "validation"
        assert config.levels is None
        assert config.max_questions is None
        assert config.max_iterations == 15
        assert config.enable_web_search
        assert config.enable_web_browse
        assert config.enable_code_execution
    
    def test_custom_config(self):
        """Test custom configuration."""
        config = GAIAConfig(
            split="test",
            levels=[GAIALevel.LEVEL_1],
            max_questions=10,
            model_name="gpt-3.5-turbo",
        )
        
        assert config.split == "test"
        assert config.levels == [GAIALevel.LEVEL_1]
        assert config.max_questions == 10
        assert config.model_name == "gpt-3.5-turbo"


class TestLeaderboardScores:
    """Tests for leaderboard scores."""
    
    def test_leaderboard_has_entries(self):
        """Test leaderboard has entries."""
        assert len(LEADERBOARD_SCORES) > 0
    
    def test_human_performance(self):
        """Test human baseline is included."""
        assert "Human Performance" in LEADERBOARD_SCORES
        human = LEADERBOARD_SCORES["Human Performance"]
        assert human["overall"] > 0.9
    
    def test_gpt4_baseline(self):
        """Test GPT-4 baseline is included."""
        baseline = LEADERBOARD_SCORES.get("GPT-4 + Plugins (baseline)", {})
        assert "overall" in baseline
        assert baseline["overall"] < 0.2  # Known to be low
