from __future__ import annotations

import pytest

from elizaos_plugin_blooio.service import BlooioService
from elizaos_plugin_blooio.types import BlooioConfig


@pytest.fixture
def config() -> BlooioConfig:
    return BlooioConfig(
        api_key="test_key",
        api_base_url="https://test.blooio.com",
        webhook_secret=None,
        webhook_port=3001,
    )


@pytest.fixture
def config_with_secret() -> BlooioConfig:
    return BlooioConfig(
        api_key="test_key",
        api_base_url="https://test.blooio.com",
        webhook_secret="test_webhook_secret",
        webhook_port=3001,
    )


@pytest.fixture
def service(config: BlooioConfig) -> BlooioService:
    return BlooioService(config)


@pytest.fixture
def service_with_secret(config_with_secret: BlooioConfig) -> BlooioService:
    return BlooioService(config_with_secret)
