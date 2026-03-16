"""Shared fixtures for Copilot Proxy tests."""

from __future__ import annotations

import pytest

from elizaos_plugin_copilot_proxy.config import CopilotProxyConfig


@pytest.fixture()
def config() -> CopilotProxyConfig:
    return CopilotProxyConfig(
        base_url="http://localhost:3000/v1",
        enabled=True,
        small_model="gpt-5-mini",
        large_model="gpt-5.1",
    )


@pytest.fixture()
def disabled_config() -> CopilotProxyConfig:
    return CopilotProxyConfig(enabled=False)
