from __future__ import annotations

import os
from unittest import mock

import pytest

from elizaos_plugin_farcaster.config import FarcasterConfig
from elizaos_plugin_farcaster.error import ConfigError


def test_config_creation() -> None:
    config = FarcasterConfig(
        fid=12345,
        signer_uuid="test-uuid",
        neynar_api_key="test-key",
    )
    assert config.fid == 12345
    assert config.signer_uuid == "test-uuid"
    assert config.neynar_api_key == "test-key"
    assert config.dry_run is False
    assert config.mode == "polling"


def test_config_with_options() -> None:
    config = FarcasterConfig(
        fid=12345,
        signer_uuid="test-uuid",
        neynar_api_key="test-key",
        dry_run=True,
        mode="webhook",
        max_cast_length=280,
        poll_interval=60,
        enable_cast=False,
    )
    assert config.dry_run is True
    assert config.mode == "webhook"
    assert config.max_cast_length == 280
    assert config.poll_interval == 60
    assert config.enable_cast is False


def test_config_from_env() -> None:
    env_vars = {
        "FARCASTER_FID": "12345",
        "FARCASTER_SIGNER_UUID": "test-uuid",
        "FARCASTER_NEYNAR_API_KEY": "test-key",
        "FARCASTER_DRY_RUN": "true",
        "FARCASTER_MODE": "webhook",
    }
    with mock.patch.dict(os.environ, env_vars, clear=False):
        config = FarcasterConfig.from_env()
        assert config.fid == 12345
        assert config.signer_uuid == "test-uuid"
        assert config.neynar_api_key == "test-key"
        assert config.dry_run is True
        assert config.mode == "webhook"


def test_config_from_env_missing_fid() -> None:
    env_vars = {
        "FARCASTER_SIGNER_UUID": "test-uuid",
        "FARCASTER_NEYNAR_API_KEY": "test-key",
    }
    with mock.patch.dict(os.environ, env_vars, clear=True):
        with pytest.raises(ConfigError, match="FARCASTER_FID"):
            FarcasterConfig.from_env()


def test_config_from_env_missing_signer() -> None:
    env_vars = {
        "FARCASTER_FID": "12345",
        "FARCASTER_NEYNAR_API_KEY": "test-key",
    }
    with mock.patch.dict(os.environ, env_vars, clear=True):
        with pytest.raises(ConfigError, match="FARCASTER_SIGNER_UUID"):
            FarcasterConfig.from_env()


def test_config_validate_invalid_fid() -> None:
    """Test validation with invalid FID."""
    config = FarcasterConfig(
        fid=0,
        signer_uuid="test-uuid",
        neynar_api_key="test-key",
    )
    with pytest.raises(ConfigError, match="FARCASTER_FID"):
        config.validate()


def test_config_validate_invalid_cast_length() -> None:
    config = FarcasterConfig(
        fid=12345,
        signer_uuid="test-uuid",
        neynar_api_key="test-key",
        max_cast_length=0,
    )
    with pytest.raises(ConfigError, match="MAX_CAST_LENGTH"):
        config.validate()
