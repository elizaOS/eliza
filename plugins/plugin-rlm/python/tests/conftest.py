"""
Pytest configuration and fixtures for RLM plugin tests.
"""

from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING, Dict, Generator
from unittest.mock import MagicMock

import pytest

# Add the plugin package to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

if TYPE_CHECKING:
    from elizaos_plugin_rlm.client import RLMClient, RLMConfig


# Check if RLM library is available
try:
    from rlm import RLM  # type: ignore[import-untyped]

    HAS_RLM = True
except ImportError:
    HAS_RLM = False


@pytest.fixture
def mock_runtime() -> MagicMock:
    """Create a mock IAgentRuntime for testing."""
    runtime = MagicMock()
    runtime.rlm_config = {}
    return runtime


@pytest.fixture
def rlm_config() -> "RLMConfig":
    """Create a default RLMConfig for testing."""
    from elizaos_plugin_rlm.client import RLMConfig

    return RLMConfig(
        backend="gemini",
        environment="local",
        max_iterations=4,
        max_depth=1,
        verbose=False,
    )


@pytest.fixture
def rlm_client(rlm_config: "RLMConfig") -> Generator["RLMClient", None, None]:
    """Create an RLMClient instance for testing."""
    from elizaos_plugin_rlm.client import RLMClient

    client = RLMClient(rlm_config)
    yield client
    # Cleanup handled by context manager in real usage


@pytest.fixture
def env_vars() -> Generator[Dict[str, str], None, None]:
    """Fixture to temporarily set environment variables."""
    original_env: Dict[str, str] = {}

    def set_env(name: str, value: str) -> None:
        if name in os.environ:
            original_env[name] = os.environ[name]
        os.environ[name] = value

    yield {"set": set_env}  # type: ignore[misc]

    # Restore original environment
    for name, value in original_env.items():
        os.environ[name] = value


# Skip markers
skip_if_no_rlm = pytest.mark.skipif(not HAS_RLM, reason="RLM library not installed")
skip_if_no_api_key = pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY") and not os.environ.get("GEMINI_API_KEY"),
    reason="No API key available for RLM backend",
)
