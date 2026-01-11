"""Tests for type definitions."""

from __future__ import annotations

import pytest

from elizaos_plugin_tee import (
    TeeMode,
    TeeVendor,
    parse_tee_mode,
    parse_tee_vendor,
)


class TestParseTeeMode:
    """Tests for parse_tee_mode function."""

    def test_parses_local(self) -> None:
        """Should parse LOCAL mode."""
        assert parse_tee_mode("LOCAL") == TeeMode.LOCAL
        assert parse_tee_mode("local") == TeeMode.LOCAL

    def test_parses_docker(self) -> None:
        """Should parse DOCKER mode."""
        assert parse_tee_mode("DOCKER") == TeeMode.DOCKER
        assert parse_tee_mode("docker") == TeeMode.DOCKER

    def test_parses_production(self) -> None:
        """Should parse PRODUCTION mode."""
        assert parse_tee_mode("PRODUCTION") == TeeMode.PRODUCTION
        assert parse_tee_mode("production") == TeeMode.PRODUCTION

    def test_raises_for_invalid_mode(self) -> None:
        """Should raise for invalid mode."""
        with pytest.raises(ValueError, match="Invalid TEE_MODE"):
            parse_tee_mode("INVALID")


class TestParseTeeVendor:
    """Tests for parse_tee_vendor function."""

    def test_parses_phala(self) -> None:
        """Should parse phala vendor."""
        assert parse_tee_vendor("phala") == TeeVendor.PHALA
        assert parse_tee_vendor("PHALA") == TeeVendor.PHALA

    def test_raises_for_invalid_vendor(self) -> None:
        """Should raise for invalid vendor."""
        with pytest.raises(ValueError, match="Invalid TEE_VENDOR"):
            parse_tee_vendor("invalid")


