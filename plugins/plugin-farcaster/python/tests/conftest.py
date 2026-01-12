from __future__ import annotations

import pytest

from elizaos_plugin_farcaster.config import FarcasterConfig


@pytest.fixture
def mock_config() -> FarcasterConfig:
    return FarcasterConfig(
        fid=12345,
        signer_uuid="test-signer-uuid",
        neynar_api_key="test-api-key",
        dry_run=True,
    )
