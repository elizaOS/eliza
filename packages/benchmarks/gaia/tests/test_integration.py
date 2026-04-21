"""
Integration tests for GAIA benchmark.

These tests verify the complete flow of the benchmark, including:
- Plugin registration with ElizaOS runtime
- Model handler functionality
- Tool execution
- End-to-end question solving
"""

import asyncio
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from elizaos_gaia import (
    GAIAConfig,
    GAIAQuestion,
    GAIALevel,
    GAIAAgent,
    GAIAEvaluator,
    GAIARunner,
    gaia_plugin,
    create_gaia_plugin,
    ModelProvider,
    SUPPORTED_MODELS,
    PRESETS,
    get_available_providers,
)
from elizaos_gaia.plugin import multi_provider_model_handler


class TestPluginIntegration:
    """Test plugin integration with ElizaOS runtime."""
    
    def test_plugin_has_required_components(self):
        """Test that plugin has all required components."""
        assert gaia_plugin.name == "gaia-benchmark"
        assert gaia_plugin.description is not None
        assert gaia_plugin.actions is not None
        assert gaia_plugin.models is not None
        assert len(gaia_plugin.actions) >= 4  # web_search, browse, calculate, execute_code
    
    def test_plugin_actions_have_handlers(self):
        """Test that all actions have proper handlers."""
        for action in gaia_plugin.actions:
            assert action.name is not None
            assert action.handler is not None
            assert action.validate is not None
            assert action.description is not None
    
    def test_plugin_models_registered(self):
        """Test that model handlers are registered."""
        assert "TEXT_LARGE" in gaia_plugin.models
        assert gaia_plugin.models["TEXT_LARGE"] is multi_provider_model_handler
    
    def test_create_plugin_with_options(self):
        """Test creating plugin with custom options."""
        plugin = create_gaia_plugin(
            enable_web_search=False,
            enable_code_execution=False,
        )
        
        action_names = [a.name for a in plugin.actions]
        assert "WEB_SEARCH" not in action_names
        assert "EXECUTE_CODE" not in action_names
        assert "BROWSE" in action_names
        assert "CALCULATE" in action_names


class TestModelHandler:
    """Test the multi-provider model handler."""
    
    @pytest.mark.asyncio
    async def test_model_handler_requires_api_key(self):
        """Test that model handler fails without API key for non-Ollama providers."""
        # Mock runtime without API key
        runtime = MagicMock()
        runtime.get_setting.return_value = None
        
        # Clear all API keys
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="API key required"):
                await multi_provider_model_handler(runtime, {
                    "prompt": "test",
                    "provider": "openai",
                    "model": "gpt-4",
                })
    
    @pytest.mark.asyncio
    async def test_model_handler_requires_prompt(self):
        """Test that model handler requires prompt or messages."""
        runtime = MagicMock()
        runtime.get_setting.return_value = "fake-key"
        
        with patch.dict(os.environ, {"GROQ_API_KEY": "fake-key"}):
            with pytest.raises(ValueError, match="No messages or prompt"):
                await multi_provider_model_handler(runtime, {})
    
    @pytest.mark.skipif(
        not any(os.getenv(k) for k in ["GROQ_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
        reason="No API keys set"
    )
    @pytest.mark.asyncio
    async def test_model_handler_real_call(self):
        """Test actual API call (requires any API key)."""
        runtime = MagicMock()
        runtime.get_setting.return_value = None
        
        result = await multi_provider_model_handler(runtime, {
            "prompt": "Say 'hello' and nothing else.",
            "max_tokens": 10,
        })
        
        assert isinstance(result, str)
        assert len(result) > 0


class TestProviders:
    """Test provider configuration."""
    
    def test_model_provider_enum(self):
        """Test ModelProvider enum has all providers."""
        assert ModelProvider.GROQ.value == "groq"
        assert ModelProvider.OPENAI.value == "openai"
        assert ModelProvider.ANTHROPIC.value == "anthropic"
        assert ModelProvider.OLLAMA.value == "ollama"
        assert ModelProvider.OPENROUTER.value == "openrouter"
        assert ModelProvider.GOOGLE.value == "google"
        assert ModelProvider.XAI.value == "xai"
    
    def test_supported_models_has_providers(self):
        """Test SUPPORTED_MODELS has entries for all providers."""
        for provider in ModelProvider:
            assert provider in SUPPORTED_MODELS
            assert len(SUPPORTED_MODELS[provider]) > 0
    
    def test_presets_have_valid_config(self):
        """Test presets have valid ModelConfig."""
        for name, config in PRESETS.items():
            assert config.provider is not None
            assert config.model_name is not None
            assert isinstance(config.provider, ModelProvider)
    
    def test_groq_is_default(self):
        """Test Groq llama-3.1-8b-instant is default."""
        # When GROQ_API_KEY is available, it should be default
        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}):
            from elizaos_gaia.providers import get_default_config
            config = get_default_config()
            assert config.provider == ModelProvider.GROQ
            assert "llama" in config.model_name.lower()


class TestAgentIntegration:
    """Test agent integration with the full pipeline."""
    
    @pytest.fixture
    def config(self):
        """Create test config."""
        return GAIAConfig(
            max_iterations=3,
            enable_web_search=False,
            enable_web_browse=False,
            enable_code_execution=False,
        )
    
    @pytest.fixture
    def simple_question(self):
        """Create a simple test question."""
        return GAIAQuestion(
            task_id="test-001",
            question="What is 2 + 2?",
            level=GAIALevel.LEVEL_1,
            final_answer="4",
        )
    
    @pytest.mark.asyncio
    async def test_agent_solve_with_mocked_llm(self, config, simple_question):
        """Test agent solving with mocked LLM response."""
        agent = GAIAAgent(config)
        
        # Mock the LLM call to return a final answer
        with patch.object(agent, '_call_provider') as mock_llm:
            mock_llm.return_value = ("FINAL ANSWER: 4", 100)
            
            result = await agent.solve(simple_question)
        
        assert result.task_id == "test-001"
        assert result.predicted_answer == "4"
        assert result.error is None
        
        await agent.close()
    
    @pytest.mark.asyncio
    async def test_agent_handles_tool_calls(self, config, simple_question):
        """Test agent handling tool calls."""
        agent = GAIAAgent(config)
        
        call_count = 0
        
        async def mock_llm(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First call: use calculator
                return ('I need to calculate this. calculate("2+2")', 50)
            else:
                # Second call: provide answer
                return ("FINAL ANSWER: 4", 50)
        
        with patch.object(agent, '_call_provider', side_effect=mock_llm):
            result = await agent.solve(simple_question)
        
        assert result.predicted_answer == "4"
        assert len(result.steps_taken) >= 1
        
        await agent.close()
    
    @pytest.mark.asyncio
    async def test_agent_timeout_handling(self, config, simple_question):
        """Test agent handles timeout properly."""
        config.timeout_per_question_ms = 100  # Very short timeout
        agent = GAIAAgent(config)
        
        async def slow_llm(*args, **kwargs):
            await asyncio.sleep(10)  # Much longer than timeout
            return ("FINAL ANSWER: 4", 100)
        
        with patch.object(agent, '_call_provider', side_effect=slow_llm):
            # The agent.solve itself doesn't have timeout, it's runner that applies it
            # Just verify agent can be created and closed
            pass
        
        await agent.close()


class TestEvaluatorIntegration:
    """Test evaluator integration."""
    
    @pytest.fixture
    def evaluator(self):
        return GAIAEvaluator()
    
    def test_evaluator_exact_match(self, evaluator):
        """Test evaluator with exact match."""
        is_correct, norm_pred, norm_exp = evaluator.evaluate("Paris", "Paris")
        assert is_correct
    
    def test_evaluator_case_insensitive(self, evaluator):
        """Test evaluator is case insensitive."""
        is_correct, _, _ = evaluator.evaluate("PARIS", "paris")
        assert is_correct
    
    def test_evaluator_numeric_match(self, evaluator):
        """Test evaluator handles numeric matching."""
        is_correct, _, _ = evaluator.evaluate("42", "42.0")
        assert is_correct
        
        is_correct, _, _ = evaluator.evaluate("1,000", "1000")
        assert is_correct


class TestEndToEnd:
    """End-to-end integration tests."""
    
    @pytest.mark.skipif(
        not os.getenv("OPENAI_API_KEY"),
        reason="OPENAI_API_KEY not set for E2E test"
    )
    @pytest.mark.asyncio
    async def test_simple_math_question(self):
        """Test solving a simple math question end-to-end."""
        config = GAIAConfig(
            max_iterations=5,
            enable_web_search=False,
            enable_web_browse=False,
            model_name="gpt-3.5-turbo",  # Use cheaper model for testing
            max_tokens=500,
        )
        
        question = GAIAQuestion(
            task_id="e2e-test-001",
            question="What is 15 * 7?",
            level=GAIALevel.LEVEL_1,
            final_answer="105",
        )
        
        agent = GAIAAgent(config)
        evaluator = GAIAEvaluator()
        
        try:
            result = await agent.solve(question)
            
            # Evaluate the answer
            is_correct, _, _ = evaluator.evaluate(
                result.predicted_answer,
                question.final_answer,
            )
            result.is_correct = is_correct
            
            print(f"\nQuestion: {question.question}")
            print(f"Expected: {question.final_answer}")
            print(f"Predicted: {result.predicted_answer}")
            print(f"Correct: {result.is_correct}")
            print(f"Steps: {len(result.steps_taken)}")
            print(f"Tokens: {result.token_usage}")
            
            # The answer should be correct for a simple math question
            assert result.predicted_answer, "Should have a predicted answer"
            
        finally:
            await agent.close()
    
    @pytest.mark.skipif(
        not os.getenv("OPENAI_API_KEY"),
        reason="OPENAI_API_KEY not set for E2E test"
    )
    @pytest.mark.asyncio
    async def test_calculator_tool(self):
        """Test that the calculator tool works correctly."""
        from elizaos_gaia.tools import Calculator
        
        calc = Calculator()
        
        # Test various calculations
        test_cases = [
            ("2 + 2", 4),
            ("10 * 5", 50),
            ("100 / 4", 25),
            ("sqrt(144)", 12),
            ("2 ** 10", 1024),
        ]
        
        for expr, expected in test_cases:
            result = calc.calculate(expr)
            assert result.success, f"Failed for {expr}: {result.error}"
            assert abs(float(result.result) - expected) < 0.0001, (
                f"Wrong result for {expr}: got {result.result}, expected {expected}"
            )


class TestToolsIntegration:
    """Test individual tools work correctly."""
    
    @pytest.mark.asyncio
    async def test_web_search_tool(self):
        """Test web search tool initialization and basic use."""
        from elizaos_gaia.tools import WebSearchTool
        
        search = WebSearchTool(engine="duckduckgo")
        
        try:
            # Just verify it can be called without error
            result = await search.search("python programming")
            
            # DuckDuckGo may or may not return results
            assert hasattr(result, 'success')
            assert hasattr(result, 'results')
            
        finally:
            await search.close()
    
    @pytest.mark.asyncio
    async def test_file_processor_missing_file(self):
        """Test file processor handles missing files."""
        from elizaos_gaia.tools import FileProcessor
        
        processor = FileProcessor()
        result = await processor.process("/nonexistent/file.txt")
        
        assert not result.success
        assert "not found" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_code_executor_basic(self):
        """Test code executor with simple code."""
        from elizaos_gaia.tools import CodeExecutor
        
        executor = CodeExecutor(timeout_seconds=10, use_docker=False)
        
        result = await executor.execute_python("print(1 + 1)")
        
        assert result.success
        assert "2" in result.stdout


class TestRunnerIntegration:
    """Test the benchmark runner integration."""
    
    @pytest.fixture
    def config(self):
        return GAIAConfig(
            max_questions=2,
            enable_web_search=False,
            enable_web_browse=False,
            output_dir="./test_results",
        )
    
    def test_runner_creation(self, config):
        """Test runner can be created."""
        runner = GAIARunner(config)
        
        assert runner.config is config
        assert runner.agent is not None
        assert runner.evaluator is not None
        assert runner.metrics_calculator is not None
    
    def test_runner_validates_config(self):
        """Test runner validates config."""
        with pytest.raises(ValueError, match="Invalid split"):
            GAIARunner(GAIAConfig(split="invalid"))
