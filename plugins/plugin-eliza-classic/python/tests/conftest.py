import pytest

from elizaos_plugin_eliza_classic import ElizaClassicPlugin


@pytest.fixture
def plugin() -> ElizaClassicPlugin:
    return ElizaClassicPlugin()
