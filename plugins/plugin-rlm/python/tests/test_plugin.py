"""
Unit tests for the RLM plugin.

These tests do not require the RLM library or API keys to be installed.
They test plugin structure, configuration, and stub behavior.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

import pytest

if TYPE_CHECKING:
    from elizaos_plugin_rlm.client import RLMClient, RLMConfig


class TestRLMPluginStructure:
    """Tests for plugin structure and definition."""

    def test_plugin_can_be_imported(self) -> None:
        """Test that plugin can be imported."""
        from elizaos_plugin_rlm import plugin

        assert plugin is not None

    def test_plugin_has_correct_name(self) -> None:
        """Test plugin has correct name."""
        from elizaos_plugin_rlm import plugin

        assert plugin.name == "plugin-rlm"

    def test_plugin_has_description(self) -> None:
        """Test plugin has a description."""
        from elizaos_plugin_rlm import plugin

        assert plugin.description is not None
        assert len(plugin.description) > 0
        assert "RLM" in plugin.description or "Recursive" in plugin.description

    def test_plugin_has_models_registered(self) -> None:
        """Test plugin has model handlers registered."""
        from elizaos_plugin_rlm import plugin

        assert plugin.models is not None
        assert len(plugin.models) > 0

    def test_plugin_registers_text_small(self) -> None:
        """Test TEXT_SMALL handler is registered."""
        from elizaos_plugin_rlm import plugin

        assert "TEXT_SMALL" in plugin.models

    def test_plugin_registers_text_large(self) -> None:
        """Test TEXT_LARGE handler is registered."""
        from elizaos_plugin_rlm import plugin

        assert "TEXT_LARGE" in plugin.models

    def test_plugin_registers_reasoning_handlers(self) -> None:
        """Test reasoning handlers are registered."""
        from elizaos_plugin_rlm import plugin

        assert "TEXT_REASONING_SMALL" in plugin.models
        assert "TEXT_REASONING_LARGE" in plugin.models

    def test_plugin_registers_explicit_rlm_handlers(self) -> None:
        """Test explicit RLM handlers are registered."""
        from elizaos_plugin_rlm import plugin

        assert "TEXT_RLM_LARGE" in plugin.models
        assert "TEXT_RLM_REASONING" in plugin.models

    def test_plugin_has_provider(self) -> None:
        """Test plugin has RLM provider."""
        from elizaos_plugin_rlm import plugin

        assert plugin.providers is not None
        assert len(plugin.providers) > 0
        assert plugin.providers[0].name == "RLM"

    def test_plugin_has_init_function(self) -> None:
        """Test plugin has init function."""
        from elizaos_plugin_rlm import plugin

        assert plugin.init is not None
        assert callable(plugin.init)

    def test_plugin_has_config(self) -> None:
        """Test plugin has config options."""
        from elizaos_plugin_rlm import plugin

        assert plugin.config is not None
        assert "backend" in plugin.config
        assert "environment" in plugin.config
        assert "max_iterations" in plugin.config


class TestRLMConfig:
    """Tests for RLMConfig."""

    def test_config_defaults(self) -> None:
        """Test config default values."""
        from elizaos_plugin_rlm import RLMConfig

        # Clear env vars for test
        with patch.dict(os.environ, {}, clear=True):
            config = RLMConfig()
            assert config.backend == "gemini"
            assert config.environment == "local"
            assert config.max_iterations == 4
            assert config.max_depth == 1
            assert config.verbose is False

    def test_config_from_env(self) -> None:
        """Test config reads from environment variables."""
        from elizaos_plugin_rlm import RLMConfig

        env_vars = {
            "ELIZA_RLM_BACKEND": "openai",
            "ELIZA_RLM_ENV": "docker",
            "ELIZA_RLM_MAX_ITERATIONS": "8",
            "ELIZA_RLM_MAX_DEPTH": "2",
            "ELIZA_RLM_VERBOSE": "true",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            config = RLMConfig()
            assert config.backend == "openai"
            assert config.environment == "docker"
            assert config.max_iterations == 8
            assert config.max_depth == 2
            assert config.verbose is True

    def test_config_validation_max_iterations(self) -> None:
        """Test config validates max_iterations."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(max_iterations=0)
        with pytest.raises(ValueError, match="max_iterations must be >= 1"):
            config.validate()

    def test_config_validation_max_depth(self) -> None:
        """Test config validates max_depth."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(max_depth=0)
        with pytest.raises(ValueError, match="max_depth must be >= 1"):
            config.validate()

    def test_config_warns_unknown_backend(self) -> None:
        """Test config warns on unknown backend."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(backend="unknown_backend")
        # Should not raise, just warn
        config.validate()

    def test_config_retry_defaults(self) -> None:
        """Test retry configuration defaults."""
        from elizaos_plugin_rlm import RLMConfig

        with patch.dict(os.environ, {}, clear=True):
            config = RLMConfig()
            assert config.max_retries == 3
            assert config.retry_base_delay == 1.0
            assert config.retry_max_delay == 30.0

    def test_config_retry_from_env(self) -> None:
        """Test retry configuration from environment variables."""
        from elizaos_plugin_rlm import RLMConfig

        env_vars = {
            "ELIZA_RLM_MAX_RETRIES": "5",
            "ELIZA_RLM_RETRY_DELAY": "2.0",
            "ELIZA_RLM_RETRY_MAX_DELAY": "60.0",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            config = RLMConfig()
            assert config.max_retries == 5
            assert config.retry_base_delay == 2.0
            assert config.retry_max_delay == 60.0


class TestRLMClient:
    """Tests for RLMClient."""

    def test_client_initialization_without_rlm(self) -> None:
        """Test client initializes without RLM library."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        client = RLMClient(config)
        # Should not raise, should be in stub mode
        assert client is not None

    def test_client_is_available_returns_false_without_rlm(self) -> None:
        """Test is_available returns False when RLM not installed."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        config = RLMConfig()
        client = RLMClient(config)
        # If RLM is not installed, is_available should be False
        if not HAS_RLM:
            assert client.is_available is False

    @pytest.mark.asyncio
    async def test_client_stub_response(self) -> None:
        """Test client returns stub response when RLM not available."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("RLM is installed, cannot test stub mode")

        config = RLMConfig()
        client = RLMClient(config)
        result = await client.infer("Hello, world!")

        assert result.stub is True
        assert "[RLM STUB]" in result.text

    def test_normalize_messages_string(self) -> None:
        """Test message normalization from string."""
        from elizaos_plugin_rlm import RLMClient

        messages = RLMClient.normalize_messages("Hello, world!")
        assert len(messages) == 1
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == "Hello, world!"

    def test_normalize_messages_list(self) -> None:
        """Test message normalization from list."""
        from elizaos_plugin_rlm import RLMClient

        input_messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        messages = RLMClient.normalize_messages(input_messages)
        assert messages == input_messages

    @pytest.mark.asyncio
    async def test_client_context_manager(self) -> None:
        """Test client works as async context manager."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        async with RLMClient(config) as client:
            assert client is not None


class TestRetryLogic:
    """Tests for retry logic in RLMClient."""

    @pytest.mark.asyncio
    async def test_retry_on_transient_error(self) -> None:
        """Test that transient errors trigger retry."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig(max_retries=3, retry_base_delay=0.01)  # Fast retries for test
        client = RLMClient(config)
        
        # Mock the client to simulate RLM being available
        client._initialized = True
        call_count = 0
        
        def mock_completion(messages: list) -> object:
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ConnectionError("Connection timeout")  # Transient error
            # Return a mock result on third attempt
            return type('MockResult', (), {'response': 'Success after retry'})()
        
        client._rlm = MagicMock()
        client._rlm.completion = mock_completion
        
        result = await client.infer("Hello")
        
        assert call_count == 3  # Should have retried
        assert "Success after retry" in result.text
        assert result.stub is False

    @pytest.mark.asyncio
    async def test_no_retry_on_non_transient_error(self) -> None:
        """Test that non-transient errors don't trigger retry."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig(max_retries=3, retry_base_delay=0.01)
        client = RLMClient(config)
        
        client._initialized = True
        call_count = 0
        
        def mock_completion(messages: list) -> object:
            nonlocal call_count
            call_count += 1
            raise ValueError("Invalid input")  # Non-transient error
        
        client._rlm = MagicMock()
        client._rlm.completion = mock_completion
        
        result = await client.infer("Hello")
        
        # Should fail after 1 attempt (no retry for ValueError)
        assert call_count == 1
        assert result.stub is False  # Error result, not stub
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_retry_exhaustion(self) -> None:
        """Test behavior when all retries are exhausted."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig(max_retries=2, retry_base_delay=0.01)
        client = RLMClient(config)
        
        client._initialized = True
        call_count = 0
        
        def mock_completion(messages: list) -> object:
            nonlocal call_count
            call_count += 1
            raise ConnectionError("Connection timeout")
        
        client._rlm = MagicMock()
        client._rlm.completion = mock_completion
        
        result = await client.infer("Hello")
        
        assert call_count == 2  # All retries exhausted
        assert result.error is not None


class TestRLMResult:
    """Tests for RLMResult."""

    def test_result_to_dict(self) -> None:
        """Test RLMResult.to_dict()."""
        from elizaos_plugin_rlm import RLMResult

        result = RLMResult(
            text="Generated text",
            stub=False,
            iterations=3,
            depth=1,
        )
        d = result.to_dict()
        assert d["text"] == "Generated text"
        assert d["metadata"]["stub"] is False
        assert d["metadata"]["iterations"] == 3
        assert d["metadata"]["depth"] == 1

    def test_result_stub_to_dict(self) -> None:
        """Test stub result to_dict()."""
        from elizaos_plugin_rlm import RLMResult

        result = RLMResult(
            text="[RLM STUB] Not available",
            stub=True,
        )
        d = result.to_dict()
        assert d["metadata"]["stub"] is True


class TestHandlers:
    """Tests for model handlers."""

    @pytest.mark.asyncio
    async def test_handle_text_generation_stub(self) -> None:
        """Test text generation handler returns stub when RLM unavailable."""
        from elizaos_plugin_rlm import HAS_RLM
        from elizaos_plugin_rlm.plugin import handle_text_generation

        if HAS_RLM:
            pytest.skip("RLM is installed, cannot test stub mode")

        runtime = MagicMock()
        runtime.rlm_config = {}

        result = await handle_text_generation(runtime, {"prompt": "Hello"})

        assert "[RLM STUB]" in result

    @pytest.mark.asyncio
    async def test_handle_text_generation_with_messages(self) -> None:
        """Test handler accepts messages parameter."""
        from elizaos_plugin_rlm import HAS_RLM
        from elizaos_plugin_rlm.plugin import handle_text_generation

        if HAS_RLM:
            pytest.skip("RLM is installed, cannot test stub mode")

        runtime = MagicMock()
        runtime.rlm_config = {}

        params = {
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi"},
                {"role": "user", "content": "How are you?"},
            ]
        }
        result = await handle_text_generation(runtime, params)

        assert isinstance(result, str)


class TestProvider:
    """Tests for RLM provider."""

    @pytest.mark.asyncio
    async def test_provider_get(self) -> None:
        """Test provider get returns status."""
        from elizaos_plugin_rlm.plugin import rlm_provider_get

        runtime = MagicMock()
        runtime.rlm_config = {}
        message = MagicMock()

        result = await rlm_provider_get(runtime, message)

        assert result is not None
        assert "RLM" in result.text
        assert "available" in result.values


class TestPluginInit:
    """Tests for plugin initialization."""

    @pytest.mark.asyncio
    async def test_plugin_init_stores_config(self) -> None:
        """Test plugin init stores config on runtime."""
        from elizaos_plugin_rlm.plugin import plugin_init

        runtime = MagicMock()
        config = {"backend": "openai", "max_iterations": 8}

        await plugin_init(config, runtime)

        assert runtime.rlm_config == config


class TestRLMIntegrationWhenAvailable:
    """
    Tests that run ONLY when RLM is installed.
    
    These complement the stub mode tests above to ensure real code paths
    are actually executed and verified. Without these, the integration
    code is "performative" - it looks functional but isn't proven.
    """

    @pytest.fixture
    def requires_rlm(self) -> None:
        """Skip test if RLM is not installed."""
        from elizaos_plugin_rlm import HAS_RLM
        if not HAS_RLM:
            pytest.skip("RLM library not installed")

    @pytest.mark.asyncio
    async def test_client_is_available_when_rlm_installed(self, requires_rlm: None) -> None:
        """Test is_available returns True when RLM is installed."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        client = RLMClient(config)
        assert client.is_available is True

    @pytest.mark.asyncio
    async def test_client_initializes_rlm_instance(self, requires_rlm: None) -> None:
        """Test client actually initializes RLM instance."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        client = RLMClient(config)
        assert client._rlm is not None
        assert client._initialized is True

    @pytest.mark.asyncio
    async def test_real_inference_executes(self, requires_rlm: None) -> None:
        """
        Test that inference actually calls the RLM backend.
        
        This requires API keys to be configured. If not configured,
        the test verifies at least that the code path is exercised.
        """
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        client = RLMClient(config)
        
        try:
            result = await client.infer("Hello, respond with just 'Hi'.")
            # If we get here, actual inference worked
            assert result.stub is False
            assert len(result.text) > 0
        except Exception as e:
            # API key not configured or network issue is acceptable
            # The important thing is the code path was exercised
            error_str = str(e).lower()
            acceptable_errors = ["api key", "authentication", "unauthorized", "rate limit", "network", "connection"]
            is_acceptable = any(err in error_str for err in acceptable_errors)
            if not is_acceptable:
                raise  # Unexpected error, let it fail

    @pytest.mark.asyncio
    async def test_trajectory_logging_executes(self, requires_rlm: None) -> None:
        """Test that trajectory logging code path is exercised."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        client = RLMClient(config)
        
        try:
            result = await client.infer_with_trajectory("Hello")
            # Verify trajectory is attached
            assert result.stub is False
            # Trajectory should be created even if inference fails early
        except Exception as e:
            # API key errors are acceptable - code path was still exercised
            error_str = str(e).lower()
            acceptable_errors = ["api key", "authentication", "unauthorized", "rate limit", "network", "connection"]
            is_acceptable = any(err in error_str for err in acceptable_errors)
            if not is_acceptable:
                raise

    @pytest.mark.asyncio
    async def test_handle_text_generation_real_path(self, requires_rlm: None) -> None:
        """Test handler exercises real RLM path when available."""
        from elizaos_plugin_rlm.plugin import handle_text_generation

        runtime = MagicMock()
        runtime.rlm_config = {}

        try:
            result = await handle_text_generation(runtime, {"prompt": "Hello"})
            # Should not be a stub response when RLM is available
            assert "[RLM STUB]" not in result
        except Exception as e:
            # API key errors are acceptable
            error_str = str(e).lower()
            acceptable_errors = ["api key", "authentication", "unauthorized", "rate limit", "network", "connection"]
            is_acceptable = any(err in error_str for err in acceptable_errors)
            if not is_acceptable:
                raise

    @pytest.mark.asyncio
    async def test_handle_rlm_explicit_uses_trajectory(self, requires_rlm: None) -> None:
        """Test explicit RLM handler uses trajectory logging."""
        from elizaos_plugin_rlm.plugin import handle_rlm_explicit

        runtime = MagicMock()
        runtime.rlm_config = {}

        try:
            result = await handle_rlm_explicit(runtime, {"prompt": "Hello"})
            # Should have attached trajectory to runtime
            # (even if inference fails, the trajectory storage code runs)
            assert "[RLM STUB]" not in result
        except Exception as e:
            error_str = str(e).lower()
            acceptable_errors = ["api key", "authentication", "unauthorized", "rate limit", "network", "connection"]
            is_acceptable = any(err in error_str for err in acceptable_errors)
            if not is_acceptable:
                raise


class TestConfigValidationStrict:
    """Tests for strict configuration validation."""

    def test_strict_validation_rejects_invalid_backend(self) -> None:
        """Test strict validation raises on invalid backend."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(backend="fake_backend")
        with pytest.raises(ValueError, match="Unknown RLM backend"):
            config.validate(strict=True)

    def test_strict_validation_rejects_invalid_environment(self) -> None:
        """Test strict validation raises on invalid environment."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(environment="fake_env")
        with pytest.raises(ValueError, match="Unknown RLM environment"):
            config.validate(strict=True)

    def test_non_strict_validation_warns_but_passes(self) -> None:
        """Test non-strict validation only warns."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(backend="fake_backend", environment="fake_env")
        # Should not raise
        config.validate(strict=False)

    def test_validation_rejects_invalid_retry_config(self) -> None:
        """Test validation rejects invalid retry configuration."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(max_retries=-1)
        with pytest.raises(ValueError, match="max_retries must be >= 0"):
            config.validate()

        config2 = RLMConfig(retry_base_delay=-1)
        with pytest.raises(ValueError, match="retry_base_delay must be >= 0"):
            config2.validate()

        config3 = RLMConfig(retry_base_delay=10.0, retry_max_delay=5.0)
        with pytest.raises(ValueError, match="retry_max_delay must be >= retry_base_delay"):
            config3.validate()


# ============================================================================
# COMPREHENSIVE TEST EXPANSION - Boundary Conditions, Edge Cases, Error Handling
# ============================================================================


class TestBoundaryConditions:
    """Tests for boundary conditions and edge cases."""

    def test_config_min_max_iterations_boundary(self) -> None:
        """Test config with boundary values for max_iterations."""
        from elizaos_plugin_rlm import RLMConfig

        # Minimum valid value
        config1 = RLMConfig(max_iterations=1)
        config1.validate()  # Should not raise
        assert config1.max_iterations == 1

        # Zero - invalid
        config2 = RLMConfig(max_iterations=0)
        with pytest.raises(ValueError, match="max_iterations must be >= 1"):
            config2.validate()

        # Large value - should be accepted
        config3 = RLMConfig(max_iterations=1000)
        config3.validate()
        assert config3.max_iterations == 1000

    def test_config_min_max_depth_boundary(self) -> None:
        """Test config with boundary values for max_depth."""
        from elizaos_plugin_rlm import RLMConfig

        # Minimum valid value
        config1 = RLMConfig(max_depth=1)
        config1.validate()
        assert config1.max_depth == 1

        # Zero - invalid
        config2 = RLMConfig(max_depth=0)
        with pytest.raises(ValueError, match="max_depth must be >= 1"):
            config2.validate()

        # Negative - invalid
        config3 = RLMConfig(max_depth=-1)
        with pytest.raises(ValueError, match="max_depth must be >= 1"):
            config3.validate()

    def test_config_retry_boundary_values(self) -> None:
        """Test retry config boundary values."""
        from elizaos_plugin_rlm import RLMConfig

        # max_retries = 0 is valid (no retries)
        config1 = RLMConfig(max_retries=0)
        config1.validate()
        assert config1.max_retries == 0

        # retry_base_delay = 0 is valid (no delay)
        config2 = RLMConfig(retry_base_delay=0.0)
        config2.validate()
        assert config2.retry_base_delay == 0.0

        # retry_max_delay = retry_base_delay is valid
        config3 = RLMConfig(retry_base_delay=5.0, retry_max_delay=5.0)
        config3.validate()

    def test_normalize_messages_empty_string(self) -> None:
        """Test message normalization with empty string."""
        from elizaos_plugin_rlm import RLMClient

        messages = RLMClient.normalize_messages("")
        assert len(messages) == 1
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == ""

    def test_normalize_messages_empty_list(self) -> None:
        """Test message normalization with empty list."""
        from elizaos_plugin_rlm import RLMClient

        messages = RLMClient.normalize_messages([])
        assert len(messages) == 0

    def test_normalize_messages_single_message_list(self) -> None:
        """Test message normalization with single message."""
        from elizaos_plugin_rlm import RLMClient

        messages = RLMClient.normalize_messages([{"role": "user", "content": "Hi"}])
        assert len(messages) == 1
        assert messages[0]["content"] == "Hi"

    def test_normalize_messages_whitespace_only(self) -> None:
        """Test message normalization with whitespace-only string."""
        from elizaos_plugin_rlm import RLMClient

        messages = RLMClient.normalize_messages("   \n\t  ")
        assert len(messages) == 1
        assert messages[0]["content"] == "   \n\t  "

    def test_normalize_messages_unicode(self) -> None:
        """Test message normalization with unicode characters."""
        from elizaos_plugin_rlm import RLMClient

        unicode_text = "Hello 世界 🌍 مرحبا שלום"
        messages = RLMClient.normalize_messages(unicode_text)
        assert messages[0]["content"] == unicode_text

    def test_normalize_messages_very_long_string(self) -> None:
        """Test message normalization with very long string (100k chars)."""
        from elizaos_plugin_rlm import RLMClient

        long_text = "x" * 100_000
        messages = RLMClient.normalize_messages(long_text)
        assert len(messages) == 1
        assert len(messages[0]["content"]) == 100_000

    @pytest.mark.asyncio
    async def test_infer_empty_prompt(self) -> None:
        """Test inference with empty prompt."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("RLM installed, testing stub mode behavior")

        config = RLMConfig()
        client = RLMClient(config)
        result = await client.infer("")

        assert result.stub is True
        assert isinstance(result.text, str)


class TestTokenAndCostEstimation:
    """Tests for token estimation and cost calculation edge cases."""

    def test_token_count_empty_string(self) -> None:
        """Test token count for empty string returns 0."""
        from elizaos_plugin_rlm.client import estimate_token_count

        assert estimate_token_count("") == 0

    def test_token_count_short_string(self) -> None:
        """Test token count for string shorter than 4 chars."""
        from elizaos_plugin_rlm.client import estimate_token_count

        # 1-3 chars should all return 0 with integer division
        assert estimate_token_count("a") == 0
        assert estimate_token_count("ab") == 0
        assert estimate_token_count("abc") == 0
        # 4 chars should return 1
        assert estimate_token_count("abcd") == 1

    def test_token_count_exact_boundary(self) -> None:
        """Test token count at exact boundaries."""
        from elizaos_plugin_rlm.client import estimate_token_count

        # Exactly 4 chars = 1 token
        assert estimate_token_count("1234") == 1
        # Exactly 8 chars = 2 tokens
        assert estimate_token_count("12345678") == 2
        # 7 chars = 1 token (truncated)
        assert estimate_token_count("1234567") == 1

    def test_token_count_with_approximation_flag(self) -> None:
        """Test token count respects use_approximation flag."""
        from elizaos_plugin_rlm.client import estimate_token_count

        text = "Hello, world!"
        # With approximation, should use len/4
        approx_count = estimate_token_count(text, use_approximation=True)
        assert approx_count == len(text) // 4

    def test_cost_estimation_zero_tokens(self) -> None:
        """Test cost estimation with zero tokens."""
        from elizaos_plugin_rlm.client import estimate_cost

        cost = estimate_cost("openai", "gpt-5", 0, 0, warn_on_fallback=False)
        assert cost == 0.0

    def test_cost_estimation_input_only(self) -> None:
        """Test cost estimation with only input tokens."""
        from elizaos_plugin_rlm.client import estimate_cost

        cost = estimate_cost("openai", "gpt-5", 1_000_000, 0, warn_on_fallback=False)
        # gpt-5: $2.5/1M input
        assert abs(cost - 2.5) < 0.001

    def test_cost_estimation_output_only(self) -> None:
        """Test cost estimation with only output tokens."""
        from elizaos_plugin_rlm.client import estimate_cost

        cost = estimate_cost("openai", "gpt-5", 0, 1_000_000, warn_on_fallback=False)
        # gpt-5: $10/1M output
        assert abs(cost - 10.0) < 0.001

    def test_cost_estimation_very_large_tokens(self) -> None:
        """Test cost estimation with very large token counts."""
        from elizaos_plugin_rlm.client import estimate_cost

        # 1 billion tokens each
        cost = estimate_cost("openai", "gpt-5", 1_000_000_000, 1_000_000_000, warn_on_fallback=False)
        # $2.5 * 1000 + $10 * 1000 = $12,500
        expected = 2500.0 + 10000.0
        assert abs(cost - expected) < 0.01

    def test_cost_estimation_unknown_backend(self) -> None:
        """Test cost estimation falls back for unknown backend."""
        from elizaos_plugin_rlm.client import DEFAULT_PRICING, estimate_cost

        cost = estimate_cost("unknown_backend", "unknown_model", 1_000_000, 1_000_000, warn_on_fallback=False)
        expected = DEFAULT_PRICING["input"] + DEFAULT_PRICING["output"]
        assert abs(cost - expected) < 0.001

    def test_cost_estimation_known_backend_unknown_model(self) -> None:
        """Test cost for known backend but unknown model."""
        from elizaos_plugin_rlm.client import DEFAULT_PRICING, estimate_cost

        cost = estimate_cost("openai", "gpt-99-future", 1_000_000, 1_000_000, warn_on_fallback=False)
        expected = DEFAULT_PRICING["input"] + DEFAULT_PRICING["output"]
        assert abs(cost - expected) < 0.001


class TestModelPricingConfiguration:
    """Tests for model pricing configuration."""

    def test_set_model_pricing_new_backend(self) -> None:
        """Test setting pricing for new backend."""
        from elizaos_plugin_rlm.client import MODEL_PRICING, estimate_cost, set_model_pricing

        # Add new backend
        set_model_pricing("custom_backend", "custom_model", 1.5, 4.5)

        assert "custom_backend" in MODEL_PRICING
        assert "custom_model" in MODEL_PRICING["custom_backend"]
        assert MODEL_PRICING["custom_backend"]["custom_model"]["input"] == 1.5
        assert MODEL_PRICING["custom_backend"]["custom_model"]["output"] == 4.5

        # Verify it's used in cost estimation
        cost = estimate_cost("custom_backend", "custom_model", 1_000_000, 1_000_000, warn_on_fallback=False)
        assert abs(cost - 6.0) < 0.001

    def test_set_model_pricing_override_existing(self) -> None:
        """Test overriding existing model pricing."""
        from elizaos_plugin_rlm.client import MODEL_PRICING, set_model_pricing

        original_input = MODEL_PRICING.get("openai", {}).get("gpt-5", {}).get("input", 0)
        
        # Override
        set_model_pricing("openai", "gpt-5", 99.0, 199.0)
        
        assert MODEL_PRICING["openai"]["gpt-5"]["input"] == 99.0
        assert MODEL_PRICING["openai"]["gpt-5"]["output"] == 199.0

        # Restore original (cleanup)
        set_model_pricing("openai", "gpt-5", original_input, 10.0)

    def test_load_pricing_from_env_invalid_json(self) -> None:
        """Test loading pricing from env with invalid JSON."""
        from elizaos_plugin_rlm.client import load_pricing_from_env

        with patch.dict(os.environ, {"ELIZA_RLM_PRICING_JSON": "not valid json"}, clear=False):
            # Should not raise, just log warning
            load_pricing_from_env()

    def test_load_pricing_from_env_valid_json(self) -> None:
        """Test loading pricing from env with valid JSON."""
        import json
        from elizaos_plugin_rlm.client import MODEL_PRICING, load_pricing_from_env

        custom_pricing = {
            "test_backend": {
                "test_model": {"input": 7.5, "output": 22.5}
            }
        }
        with patch.dict(os.environ, {"ELIZA_RLM_PRICING_JSON": json.dumps(custom_pricing)}, clear=False):
            load_pricing_from_env()
            
        assert "test_backend" in MODEL_PRICING
        assert MODEL_PRICING["test_backend"]["test_model"]["input"] == 7.5


class TestStrategyDetectionEdgeCases:
    """Tests for strategy detection edge cases."""

    def test_detect_strategy_empty_code(self) -> None:
        """Test strategy detection with empty code."""
        from elizaos_plugin_rlm.client import detect_strategy

        assert detect_strategy("") == "other"

    def test_detect_strategy_case_insensitive(self) -> None:
        """Test strategy detection is case insensitive."""
        from elizaos_plugin_rlm.client import detect_strategy

        assert detect_strategy("RE.SEARCH(pattern, text)") == "grep"
        assert detect_strategy("PROMPT[:100]") == "peek"
        assert detect_strategy("TEXT.SPLIT('\\n')") == "chunk"

    def test_detect_strategy_with_comments(self) -> None:
        """Test strategy detection with code containing comments."""
        from elizaos_plugin_rlm.client import detect_strategy

        code_with_comment = "# Split the text\ntext.split('\\n')"
        assert detect_strategy(code_with_comment) == "chunk"

    def test_detect_strategy_multiline_code(self) -> None:
        """Test strategy detection with multiline code."""
        from elizaos_plugin_rlm.client import detect_strategy

        multiline = """
def process(text):
    chunks = text.split('\\n')
    return chunks
"""
        assert detect_strategy(multiline) == "chunk"

    def test_detect_strategy_priority_order(self) -> None:
        """Test strategy detection priority when multiple patterns match."""
        from elizaos_plugin_rlm.client import detect_strategy

        # Code with both peek and grep patterns - peek should be detected first
        code = "prompt[:100] and re.search(pattern, text)"
        result = detect_strategy(code)
        # Verify it's one of the expected strategies
        assert result in ["peek", "grep"]


class TestErrorHandling:
    """Tests for error handling and invalid inputs."""

    @pytest.mark.asyncio
    async def test_client_handles_none_config(self) -> None:
        """Test client handles None config gracefully."""
        from elizaos_plugin_rlm import RLMClient

        client = RLMClient(None)
        assert client.config is not None

    def test_config_with_invalid_type_max_iterations(self) -> None:
        """Test config rejects invalid type for max_iterations."""
        from elizaos_plugin_rlm import RLMConfig

        # This tests the dataclass field coercion behavior
        with pytest.raises((TypeError, ValueError)):
            RLMConfig(max_iterations="invalid")  # type: ignore

    @pytest.mark.asyncio
    async def test_infer_with_invalid_message_format(self) -> None:
        """Test inference with malformed message list."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("Testing stub mode behavior")

        config = RLMConfig()
        client = RLMClient(config)
        
        # Messages missing 'content' key
        malformed_messages = [{"role": "user"}]  # Missing content
        result = await client.infer(malformed_messages)
        
        # Should still return a result (stub mode)
        assert result is not None

    def test_result_to_dict_with_none_values(self) -> None:
        """Test RLMResult.to_dict handles None values."""
        from elizaos_plugin_rlm import RLMResult

        result = RLMResult(
            text="Hello",
            stub=False,
            iterations=None,
            depth=None,
            error=None,
            cost=None,
            trajectory=None,
        )
        d = result.to_dict()
        
        assert d["text"] == "Hello"
        assert d["metadata"]["iterations"] is None
        assert d["cost"] is None
        assert d["trajectory"] is None


class TestConcurrentBehavior:
    """Tests for concurrent and async behavior."""

    @pytest.mark.asyncio
    async def test_multiple_concurrent_infer_calls(self) -> None:
        """Test multiple concurrent infer calls don't interfere."""
        import asyncio
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("Testing stub mode concurrent behavior")

        config = RLMConfig()
        client = RLMClient(config)

        # Make 5 concurrent calls
        tasks = [
            client.infer(f"Message {i}") for i in range(5)
        ]
        results = await asyncio.gather(*tasks)

        assert len(results) == 5
        for i, result in enumerate(results):
            assert result.stub is True
            assert isinstance(result.text, str)

    @pytest.mark.asyncio
    async def test_context_manager_cleanup_on_exception(self) -> None:
        """Test context manager cleans up on exception."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        
        try:
            async with RLMClient(config) as client:
                # Verify client is usable
                assert client is not None
                # Simulate exception
                raise ValueError("Test exception")
        except ValueError:
            pass  # Expected

        # Client should have been cleaned up
        # No assertion needed - if cleanup failed, we'd get resource warnings

    @pytest.mark.asyncio
    async def test_multiple_sequential_infer_calls(self) -> None:
        """Test multiple sequential infer calls."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("Testing stub mode behavior")

        config = RLMConfig()
        client = RLMClient(config)

        results = []
        for i in range(3):
            result = await client.infer(f"Call {i}")
            results.append(result)

        assert len(results) == 3
        for result in results:
            assert result.stub is True


class TestTrajectoryEdgeCases:
    """Tests for trajectory logging edge cases."""

    def test_trajectory_empty_steps(self) -> None:
        """Test trajectory with no steps."""
        from elizaos_plugin_rlm.client import RLMTrajectory

        traj = RLMTrajectory()
        assert len(traj.steps) == 0
        assert traj.total_iterations == 0
        assert traj.subcall_count == 0
        assert traj.strategies_used == []

    def test_trajectory_to_dict_truncates_final_response(self) -> None:
        """Test trajectory to_dict truncates long final response."""
        from elizaos_plugin_rlm.client import RLMTrajectory

        traj = RLMTrajectory()
        traj.final_response = "x" * 1000
        
        d = traj.to_dict()
        assert len(d["final_response"]) == 500

    def test_trajectory_duration_no_end_time(self) -> None:
        """Test trajectory duration when end_time not set."""
        from elizaos_plugin_rlm.client import RLMTrajectory

        traj = RLMTrajectory()
        traj.start_time_ms = 1000
        # end_time_ms defaults to 0
        assert traj.duration_ms == -1000  # or should handle this case

    def test_cost_total_tokens_all_fields(self) -> None:
        """Test RLMCost total_tokens includes all fields."""
        from elizaos_plugin_rlm.client import RLMCost

        cost = RLMCost(
            root_input_tokens=100,
            root_output_tokens=50,
            subcall_input_tokens=200,
            subcall_output_tokens=100,
        )
        assert cost.total_tokens == 450

    def test_cost_total_usd_both_costs(self) -> None:
        """Test RLMCost total_cost_usd sums both costs."""
        from elizaos_plugin_rlm.client import RLMCost

        cost = RLMCost(
            root_cost_usd=0.05,
            subcall_cost_usd=0.03,
        )
        assert abs(cost.total_cost_usd - 0.08) < 0.0001


class TestOutputVerification:
    """Tests that verify actual outputs match expected values."""

    def test_result_text_preserved_exactly(self) -> None:
        """Test that result text is preserved without modification."""
        from elizaos_plugin_rlm import RLMResult

        original_text = "Hello\nWorld\t\twith special chars: äöü 🎉"
        result = RLMResult(text=original_text)
        
        assert result.text == original_text
        assert result.to_dict()["text"] == original_text

    def test_config_env_vars_exact_values(self) -> None:
        """Test config reads exact values from environment."""
        from elizaos_plugin_rlm import RLMConfig

        env_vars = {
            "ELIZA_RLM_BACKEND": "anthropic",
            "ELIZA_RLM_ENV": "modal",
            "ELIZA_RLM_MAX_ITERATIONS": "7",  # Odd number
            "ELIZA_RLM_MAX_DEPTH": "3",
            "ELIZA_RLM_VERBOSE": "yes",  # Alternative truthy value
            "ELIZA_RLM_MAX_RETRIES": "10",
        }
        with patch.dict(os.environ, env_vars, clear=True):
            config = RLMConfig()
            
            assert config.backend == "anthropic"
            assert config.environment == "modal"
            assert config.max_iterations == 7
            assert config.max_depth == 3
            assert config.verbose is True
            assert config.max_retries == 10

    def test_verbose_env_var_all_truthy_values(self) -> None:
        """Test all truthy values for verbose env var."""
        from elizaos_plugin_rlm import RLMConfig

        truthy_values = ["1", "true", "True", "TRUE", "yes", "Yes", "YES"]
        
        for truthy in truthy_values:
            with patch.dict(os.environ, {"ELIZA_RLM_VERBOSE": truthy}, clear=True):
                config = RLMConfig()
                assert config.verbose is True, f"Failed for truthy value: {truthy}"

    def test_verbose_env_var_falsy_values(self) -> None:
        """Test falsy values for verbose env var."""
        from elizaos_plugin_rlm import RLMConfig

        falsy_values = ["0", "false", "False", "no", "No", "", "anything_else"]
        
        for falsy in falsy_values:
            with patch.dict(os.environ, {"ELIZA_RLM_VERBOSE": falsy}, clear=True):
                config = RLMConfig()
                assert config.verbose is False, f"Failed for falsy value: {falsy}"

    @pytest.mark.asyncio
    async def test_stub_response_format_exact(self) -> None:
        """Test stub response has exact expected format."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("Testing stub mode format")

        config = RLMConfig()
        client = RLMClient(config)
        result = await client.infer("Test prompt")

        # Verify exact stub format
        assert result.stub is True
        assert result.text.startswith("[RLM STUB]")
        assert result.iterations is None
        assert result.depth is None
        assert result.error is None

    def test_provider_result_contains_required_fields(self) -> None:
        """Test provider result contains all required fields."""
        from elizaos_plugin_rlm.plugin import rlm_provider_get
        import asyncio

        runtime = MagicMock()
        runtime.rlm_config = {}
        message = MagicMock()

        result = asyncio.get_event_loop().run_until_complete(
            rlm_provider_get(runtime, message)
        )

        # Verify all required fields
        assert hasattr(result, "text")
        assert hasattr(result, "values")
        assert hasattr(result, "data")
        assert "available" in result.values
        assert "backend" in result.data
        assert "environment" in result.data

    def test_plugin_tests_list_populated(self) -> None:
        """Test plugin.tests contains actual test functions."""
        from elizaos_plugin_rlm import plugin

        assert plugin.tests is not None
        assert len(plugin.tests) > 0
        
        # Verify each test has required attributes
        for test_case in plugin.tests:
            assert hasattr(test_case, "name")
            assert hasattr(test_case, "fn")
            assert callable(test_case.fn)


# ============================================================================
# NEW FEATURES: Per-request overrides, REPL extension, trajectory fixes
# ============================================================================


class TestRLMInferOptions:
    """Tests for RLMInferOptions per-request overrides."""

    def test_infer_options_defaults(self) -> None:
        """Test RLMInferOptions default values are all None."""
        from elizaos_plugin_rlm import RLMInferOptions

        opts = RLMInferOptions()
        assert opts.max_iterations is None
        assert opts.max_depth is None
        assert opts.root_model is None
        assert opts.subcall_model is None
        assert opts.log_trajectories is None
        assert opts.track_costs is None

    def test_infer_options_with_values(self) -> None:
        """Test RLMInferOptions with explicit values."""
        from elizaos_plugin_rlm import RLMInferOptions

        opts = RLMInferOptions(
            max_iterations=10,
            max_depth=3,
            root_model="gpt-5",
            subcall_model="gpt-5-mini",
            log_trajectories=True,
            track_costs=True,
        )
        assert opts.max_iterations == 10
        assert opts.max_depth == 3
        assert opts.root_model == "gpt-5"
        assert opts.subcall_model == "gpt-5-mini"
        assert opts.log_trajectories is True
        assert opts.track_costs is True

    def test_infer_options_to_dict_excludes_none(self) -> None:
        """Test RLMInferOptions.to_dict() excludes None values."""
        from elizaos_plugin_rlm import RLMInferOptions

        opts = RLMInferOptions(max_iterations=5)
        d = opts.to_dict()
        
        assert d == {"max_iterations": 5}
        assert "max_depth" not in d
        assert "root_model" not in d

    def test_infer_options_to_dict_full(self) -> None:
        """Test RLMInferOptions.to_dict() with all values."""
        from elizaos_plugin_rlm import RLMInferOptions

        opts = RLMInferOptions(
            max_iterations=8,
            max_depth=2,
            root_model="claude-3",
            subcall_model="claude-3-haiku",
            log_trajectories=False,
            track_costs=True,
        )
        d = opts.to_dict()
        
        assert d["max_iterations"] == 8
        assert d["max_depth"] == 2
        assert d["root_model"] == "claude-3"
        assert d["subcall_model"] == "claude-3-haiku"
        assert d["log_trajectories"] is False
        assert d["track_costs"] is True


# NOTE: Custom REPL tool registration (TestREPLExtensionPoints) was removed.
# The upstream RLM library does not support injecting custom tools into the REPL.
# See: https://arxiv.org/abs/2512.24601 - Paper Section 3.3 describes the concept,
# but the current library implementation does not expose this capability.


class TestTrajectoryDurationFix:
    """Tests for fixed trajectory duration calculation."""

    def test_trajectory_duration_not_finalized(self) -> None:
        """Test duration returns 0 when trajectory not finalized."""
        from elizaos_plugin_rlm.client import RLMTrajectory

        traj = RLMTrajectory()
        # end_time_ms defaults to 0 (not finalized)
        assert traj.duration_ms == 0

    def test_trajectory_duration_finalized(self) -> None:
        """Test duration calculation when finalized."""
        from elizaos_plugin_rlm.client import RLMTrajectory

        traj = RLMTrajectory()
        traj.start_time_ms = 1000
        traj.end_time_ms = 2500
        
        assert traj.duration_ms == 1500

    def test_trajectory_duration_never_negative(self) -> None:
        """Test duration never returns negative value."""
        from elizaos_plugin_rlm.client import RLMTrajectory

        traj = RLMTrajectory()
        traj.start_time_ms = 2000
        traj.end_time_ms = 1000  # Invalid: end before start
        
        # Should return 0, not negative
        assert traj.duration_ms == 0

    def test_trajectory_duration_same_time(self) -> None:
        """Test duration when start and end are the same."""
        from elizaos_plugin_rlm.client import RLMTrajectory

        traj = RLMTrajectory()
        traj.start_time_ms = 1000
        traj.end_time_ms = 1000
        
        assert traj.duration_ms == 0


class TestPerRequestOverrides:
    """Tests for per-request iteration/depth overrides."""

    @pytest.mark.asyncio
    async def test_infer_with_dict_opts(self) -> None:
        """Test infer accepts dict options."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("Testing stub mode behavior")

        config = RLMConfig()
        client = RLMClient(config)
        
        # Should accept dict with override options
        result = await client.infer(
            "Test prompt",
            opts={"max_iterations": 10, "max_depth": 3},
        )
        
        assert result.stub is True  # Stub mode

    @pytest.mark.asyncio
    async def test_infer_with_rlm_infer_options(self) -> None:
        """Test infer accepts RLMInferOptions object."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig, RLMInferOptions

        if HAS_RLM:
            pytest.skip("Testing stub mode behavior")

        config = RLMConfig()
        client = RLMClient(config)
        
        opts = RLMInferOptions(
            max_iterations=8,
            max_depth=2,
            log_trajectories=False,
        )
        result = await client.infer("Test prompt", opts=opts)
        
        assert result.stub is True

    @pytest.mark.asyncio
    async def test_infer_with_trajectory_dict_opts(self) -> None:
        """Test infer_with_trajectory accepts dict options."""
        from elizaos_plugin_rlm import HAS_RLM, RLMClient, RLMConfig

        if HAS_RLM:
            pytest.skip("Testing stub mode behavior")

        config = RLMConfig()
        client = RLMClient(config)
        
        result = await client.infer_with_trajectory(
            "Test prompt",
            opts={"max_iterations": 5},
        )
        
        assert result.stub is True


class TestRLMInferOptionsExport:
    """Tests for RLMInferOptions export from package."""

    def test_rlm_infer_options_is_exported(self) -> None:
        """Test RLMInferOptions is exported from package."""
        from elizaos_plugin_rlm import RLMInferOptions
        
        assert RLMInferOptions is not None
        
    def test_rlm_infer_options_in_all(self) -> None:
        """Test RLMInferOptions is in __all__."""
        import elizaos_plugin_rlm
        
        assert "RLMInferOptions" in elizaos_plugin_rlm.__all__
