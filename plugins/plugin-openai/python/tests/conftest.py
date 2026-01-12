import os

import pytest

from elizaos_plugin_openai import OpenAIConfig, OpenAIPlugin


def get_api_key() -> str:
    """Get API key from environment, fail if not available."""
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        pytest.skip("OPENAI_API_KEY not set - skipping live API tests")
    return key


@pytest.fixture
def api_key() -> str:
    return get_api_key()


@pytest.fixture
def openai_config(api_key: str) -> OpenAIConfig:
    return OpenAIConfig(
        api_key=api_key,
        small_model="gpt-5-mini",
        large_model="gpt-5",
        embedding_model="text-embedding-3-small",
        embedding_dimensions=1536,
    )


@pytest.fixture
async def plugin(api_key: str) -> OpenAIPlugin:
    plugin = OpenAIPlugin(api_key=api_key)
    yield plugin
    await plugin.close()
