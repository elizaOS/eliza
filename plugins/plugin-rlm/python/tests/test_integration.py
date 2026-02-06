"""
Integration tests for the RLM plugin.

These tests require the RLM library and API keys to be installed.
They are skipped if the required dependencies are not available.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from elizaos_plugin_rlm.client import RLMClient, RLMConfig

# Check if RLM library is available
try:
    from rlm import RLM  # type: ignore[import-untyped]

    HAS_RLM = True
except ImportError:
    HAS_RLM = False

# Check if API keys are available
HAS_API_KEY = bool(
    os.environ.get("OPENAI_API_KEY")
    or os.environ.get("GEMINI_API_KEY")
    or os.environ.get("ANTHROPIC_API_KEY")
)


@pytest.mark.skipif(not HAS_RLM, reason="RLM library not installed")
class TestRLMLibraryAvailable:
    """Tests that run when RLM library is installed."""

    def test_rlm_import(self) -> None:
        """Test RLM can be imported."""
        from rlm import RLM  # type: ignore[import-untyped]

        assert RLM is not None

    def test_client_initializes_with_rlm(self) -> None:
        """Test client initializes when RLM is available."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig()
        client = RLMClient(config)
        # With RLM installed, client should be available
        assert client._initialized is True

    def test_has_rlm_flag_true(self) -> None:
        """Test HAS_RLM flag is True when library installed."""
        from elizaos_plugin_rlm import HAS_RLM

        assert HAS_RLM is True


@pytest.mark.skipif(not HAS_RLM, reason="RLM library not installed")
@pytest.mark.skipif(not HAS_API_KEY, reason="No API key available")
class TestRLMIntegration:
    """Integration tests that require RLM library and API key."""

    @pytest.mark.asyncio
    async def test_simple_completion(self) -> None:
        """Test simple RLM completion."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig(
            backend="openai" if os.environ.get("OPENAI_API_KEY") else "gemini",
            max_iterations=2,  # Keep short for testing
            max_depth=1,
            verbose=False,
        )
        client = RLMClient(config)

        result = await client.infer("What is 2 + 2? Answer with just the number.")

        assert result.stub is False
        assert len(result.text) > 0
        # Should contain "4" somewhere in the response
        assert "4" in result.text

    @pytest.mark.asyncio
    async def test_completion_with_messages(self) -> None:
        """Test RLM completion with message list."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig(
            backend="openai" if os.environ.get("OPENAI_API_KEY") else "gemini",
            max_iterations=2,
            max_depth=1,
        )
        client = RLMClient(config)

        messages = [
            {"role": "user", "content": "Remember: the magic word is 'banana'."},
            {"role": "assistant", "content": "I'll remember that the magic word is banana."},
            {"role": "user", "content": "What is the magic word?"},
        ]
        result = await client.infer(messages)

        assert result.stub is False
        assert "banana" in result.text.lower()

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_long_context_processing(self) -> None:
        """Test RLM can process longer context."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig(
            backend="openai" if os.environ.get("OPENAI_API_KEY") else "gemini",
            max_iterations=4,
            max_depth=1,
        )
        client = RLMClient(config)

        # Create a moderately long context
        context = "The following is a list of items:\n"
        for i in range(100):
            context += f"- Item {i}: This is item number {i}\n"
        context += "\nHow many items are in the list?"

        result = await client.infer(context)

        assert result.stub is False
        assert "100" in result.text

    @pytest.mark.asyncio
    async def test_error_handling(self) -> None:
        """Test client handles errors gracefully."""
        from elizaos_plugin_rlm import RLMClient, RLMConfig

        config = RLMConfig(
            backend="invalid_backend_that_does_not_exist",
            max_iterations=1,
            max_depth=1,
        )
        # This should not raise during initialization
        client = RLMClient(config)

        # May fail during inference depending on backend validation
        # Either way, should not raise unhandled exception
        result = await client.infer("Hello")
        assert result is not None


@pytest.mark.skipif(not HAS_RLM, reason="RLM library not installed")
class TestRLMEnvironments:
    """Tests for different RLM environments."""

    def test_local_environment_config(self) -> None:
        """Test local environment configuration."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(environment="local")
        config.validate()  # Should not raise

    def test_docker_environment_config(self) -> None:
        """Test docker environment configuration."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(environment="docker")
        config.validate()  # Should not raise

    @pytest.mark.skipif(
        not os.environ.get("MODAL_TOKEN_ID"),
        reason="Modal credentials not available",
    )
    def test_modal_environment_config(self) -> None:
        """Test modal environment configuration."""
        from elizaos_plugin_rlm import RLMConfig

        config = RLMConfig(environment="modal")
        config.validate()


class TestServerIPC:
    """Tests for the IPC server."""

    @pytest.mark.asyncio
    async def test_server_handles_status_request(self) -> None:
        """Test server handles status request."""
        from elizaos_plugin_rlm.server import RLMServer

        server = RLMServer()
        response = await server.handle_request({"id": 1, "method": "status", "params": {}})

        assert response["id"] == 1
        assert "result" in response
        assert "available" in response["result"]

    @pytest.mark.asyncio
    async def test_server_handles_unknown_method(self) -> None:
        """Test server handles unknown method."""
        from elizaos_plugin_rlm.server import RLMServer

        server = RLMServer()
        response = await server.handle_request(
            {"id": 1, "method": "unknown_method", "params": {}}
        )

        assert response["id"] == 1
        assert "error" in response

    @pytest.mark.asyncio
    async def test_server_handles_infer_stub(self) -> None:
        """Test server handles infer request in stub mode."""
        from elizaos_plugin_rlm import HAS_RLM
        from elizaos_plugin_rlm.server import RLMServer

        if HAS_RLM:
            pytest.skip("RLM is installed, cannot test stub mode")

        server = RLMServer()
        response = await server.handle_request(
            {"id": 1, "method": "infer", "params": {"prompt": "Hello"}}
        )

        assert response["id"] == 1
        assert "result" in response
        assert response["result"]["metadata"]["stub"] is True

    @pytest.mark.asyncio
    async def test_server_shutdown(self) -> None:
        """Test server shutdown."""
        from elizaos_plugin_rlm.server import RLMServer

        server = RLMServer()
        response = await server.handle_request(
            {"id": 1, "method": "shutdown", "params": {}}
        )

        assert response["id"] == 1
        assert response["result"]["shutdown"] is True
        assert server._running is False
