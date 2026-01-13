from __future__ import annotations

import pytest

from elizaos_plugin_tee import (
    TeeMode,
    TeeVendor,
    parse_tee_mode,
    parse_tee_vendor,
)


class TestParseTeeMode:
    def test_parses_local(self) -> None:
        assert parse_tee_mode("LOCAL") == TeeMode.LOCAL
        assert parse_tee_mode("local") == TeeMode.LOCAL

    def test_parses_docker(self) -> None:
        assert parse_tee_mode("DOCKER") == TeeMode.DOCKER
        assert parse_tee_mode("docker") == TeeMode.DOCKER

    def test_parses_production(self) -> None:
        assert parse_tee_mode("PRODUCTION") == TeeMode.PRODUCTION
        assert parse_tee_mode("production") == TeeMode.PRODUCTION

    def test_raises_for_invalid_mode(self) -> None:
        with pytest.raises(ValueError, match="Invalid TEE_MODE"):
            parse_tee_mode("INVALID")


class TestParseTeeVendor:
    def test_parses_phala(self) -> None:
        assert parse_tee_vendor("phala") == TeeVendor.PHALA
        assert parse_tee_vendor("PHALA") == TeeVendor.PHALA

    def test_raises_for_invalid_vendor(self) -> None:
        with pytest.raises(ValueError, match="Invalid TEE_VENDOR"):
            parse_tee_vendor("invalid")
