"""Shared fixtures for Tlon plugin tests."""

from __future__ import annotations

import pytest

from elizaos_plugin_tlon.config import TlonConfig
from elizaos_plugin_tlon.types import (
    TlonChannelType,
    TlonChat,
    TlonMessagePayload,
    TlonShip,
)


@pytest.fixture()
def sample_config() -> TlonConfig:
    """Minimal valid config for testing."""
    return TlonConfig(
        ship="~sampel-palnet",
        url="https://sampel-palnet.tlon.network/",
        code="lidlut-tabwed-pillex-ridrup",
    )


@pytest.fixture()
def disabled_config() -> TlonConfig:
    """Config with enabled=False."""
    return TlonConfig(
        ship="sampel-palnet",
        url="https://sampel-palnet.tlon.network",
        code="code",
        enabled=False,
    )


@pytest.fixture()
def config_with_allowlist() -> TlonConfig:
    """Config with a DM allowlist."""
    return TlonConfig(
        ship="my-ship",
        url="https://example.com",
        code="code",
        dm_allowlist=["~allowed-ship", "another-ship"],
    )


@pytest.fixture()
def sample_ship() -> TlonShip:
    """A sample TlonShip instance."""
    return TlonShip(name="sampel-palnet")


@pytest.fixture()
def dm_chat() -> TlonChat:
    """A sample DM chat."""
    return TlonChat.dm("sampel-palnet")


@pytest.fixture()
def group_chat() -> TlonChat:
    """A sample group chat."""
    return TlonChat.group(
        "chat/~host-ship/general",
        name="general",
        host_ship="host-ship",
    )


@pytest.fixture()
def sample_message_payload(sample_ship: TlonShip, dm_chat: TlonChat) -> TlonMessagePayload:
    """A sample message payload."""
    return TlonMessagePayload(
        message_id="msg-001",
        chat=dm_chat,
        from_ship=sample_ship,
        text="Hello from Urbit!",
        timestamp=1700000000000,
    )
