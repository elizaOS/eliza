"""Tests for input validation across GAIA benchmark components."""

import pytest
from elizaos_gaia.types import GAIAConfig, GAIALevel
from elizaos_gaia.dataset import GAIADataset
from elizaos_gaia.runner import GAIARunner
from elizaos_gaia.agent import GAIAAgent


class TestConfigValidation:
    """Tests for GAIAConfig validation."""
    
    def test_valid_config(self):
        """Test creating valid config."""
        config = GAIAConfig(
            split="validation",
            levels=[GAIALevel.LEVEL_1],
            max_questions=10,
        )
        assert config.split == "validation"
    
    def test_runner_validates_split(self):
        """Test that runner validates split value."""
        config = GAIAConfig(split="invalid_split")
        
        with pytest.raises(ValueError, match="Invalid split"):
            GAIARunner(config)
    
    def test_runner_accepts_validation_split(self):
        """Test runner accepts 'validation' split."""
        config = GAIAConfig(split="validation")
        runner = GAIARunner(config)
        assert runner.config.split == "validation"
    
    def test_runner_accepts_test_split(self):
        """Test runner accepts 'test' split."""
        config = GAIAConfig(split="test")
        runner = GAIARunner(config)
        assert runner.config.split == "test"


class TestDatasetValidation:
    """Tests for dataset validation."""
    
    @pytest.fixture
    def dataset(self):
        """Create dataset instance."""
        return GAIADataset()
    
    @pytest.mark.asyncio
    async def test_load_validates_split(self, dataset):
        """Test that load validates split value."""
        with pytest.raises(ValueError, match="Invalid split"):
            await dataset.load(split="invalid")
    
    def test_parse_question_validates_task_id(self, dataset):
        """Test that _parse_question validates task_id."""
        with pytest.raises(ValueError, match="Missing required field: task_id"):
            dataset._parse_question({})
    
    def test_parse_question_validates_question(self, dataset):
        """Test that _parse_question validates question field."""
        with pytest.raises(ValueError, match="Missing required field 'question'"):
            dataset._parse_question({"task_id": "test-001"})
    
    def test_parse_question_validates_level(self, dataset):
        """Test that _parse_question validates level."""
        with pytest.raises(ValueError, match="Invalid level"):
            dataset._parse_question({
                "task_id": "test-001",
                "Question": "What is 2+2?",
                "Level": "invalid",
            })
    
    def test_parse_question_accepts_valid_data(self, dataset):
        """Test that _parse_question accepts valid data."""
        question = dataset._parse_question({
            "task_id": "test-001",
            "Question": "What is 2+2?",
            "Level": "1",
            "Final answer": "4",
        })
        
        assert question.task_id == "test-001"
        assert question.question == "What is 2+2?"
        assert question.level == GAIALevel.LEVEL_1
        assert question.final_answer == "4"
    
    def test_parse_question_handles_missing_answer(self, dataset):
        """Test that missing final_answer is handled (for test set)."""
        question = dataset._parse_question({
            "task_id": "test-001",
            "Question": "What is 2+2?",
            "Level": "1",
        })
        
        assert question.final_answer == ""


class TestAgentValidation:
    """Tests for agent validation."""
    
    def test_agent_validates_config_type(self):
        """Test that agent validates config type."""
        with pytest.raises(TypeError, match="config must be GAIAConfig"):
            GAIAAgent(config="not a config")  # type: ignore
    
    def test_agent_accepts_valid_config(self):
        """Test that agent accepts valid config."""
        config = GAIAConfig()
        agent = GAIAAgent(config)
        assert agent.config is config


class TestToolValidation:
    """Tests for tool input validation."""
    
    def test_calculator_handles_invalid_expression(self):
        """Test calculator handles invalid expressions."""
        from elizaos_gaia.tools.calculator import Calculator
        
        calc = Calculator()
        result = calc.calculate("2 +")
        
        assert not result.success
        assert result.error is not None
    
    def test_calculator_handles_division_by_zero(self):
        """Test calculator handles division by zero."""
        from elizaos_gaia.tools.calculator import Calculator
        
        calc = Calculator()
        result = calc.calculate("1 / 0")
        
        assert not result.success
        assert "zero" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_file_processor_handles_missing_file(self):
        """Test file processor handles missing files."""
        from elizaos_gaia.tools.file_processor import FileProcessor
        
        processor = FileProcessor()
        result = await processor.process("/nonexistent/file.txt")
        
        assert not result.success
        assert "not found" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_web_search_handles_errors(self):
        """Test web search handles errors gracefully."""
        from elizaos_gaia.tools.web_search import WebSearchTool
        
        # With a clearly invalid API key, the search should fail gracefully
        search = WebSearchTool(api_key="invalid", engine="serper")
        result = await search.search("test query")
        
        # Should return a failure result, not raise exception
        assert not result.success or len(result.results) == 0
        await search.close()


class TestResultValidation:
    """Tests for result structure validation."""
    
    def test_gaia_result_requires_fields(self):
        """Test that GAIAResult requires all fields."""
        from elizaos_gaia.types import GAIAResult, GAIALevel
        
        # This should work with all required fields
        result = GAIAResult(
            task_id="test",
            level=GAIALevel.LEVEL_1,
            question="Q",
            predicted_answer="A",
            expected_answer="A",
            is_correct=True,
        )
        
        assert result.task_id == "test"
        assert result.is_correct
    
    def test_gaia_metrics_default_values(self):
        """Test that GAIAMetrics has sensible defaults."""
        from elizaos_gaia.types import GAIAMetrics
        
        metrics = GAIAMetrics(
            overall_accuracy=0.5,
            total_questions=10,
            correct_answers=5,
            incorrect_answers=5,
            errors=0,
        )
        
        assert metrics.level_accuracy == {}
        assert metrics.tool_usage == {}
        assert metrics.error_categories == {}
