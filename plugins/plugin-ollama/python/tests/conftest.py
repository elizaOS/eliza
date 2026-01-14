from __future__ import annotations

import pytest

from elizaos_plugin_ollama import OllamaConfig


@pytest.fixture
def mock_config() -> OllamaConfig:
    return OllamaConfig(
        base_url="http://localhost:11434",
        small_model="gemma3:latest",
        large_model="gemma3:latest",
        embedding_model="nomic-embed-text:latest",
        timeout_seconds=30,
    )
