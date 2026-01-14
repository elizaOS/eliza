from __future__ import annotations

import pytest

from elizaos_plugin_tee import (
    bytes_to_hex,
    calculate_sha256,
    get_tee_endpoint,
    hex_to_bytes,
)


class TestHexToBytes:
    def test_converts_valid_hex_string(self) -> None:
        result = hex_to_bytes("0102030405")
        assert result == bytes([1, 2, 3, 4, 5])

    def test_handles_0x_prefix(self) -> None:
        result = hex_to_bytes("0x0102030405")
        assert result == bytes([1, 2, 3, 4, 5])

    def test_raises_for_empty_string(self) -> None:
        with pytest.raises(ValueError, match="Invalid hex string"):
            hex_to_bytes("")

    def test_raises_for_0x_only(self) -> None:
        with pytest.raises(ValueError, match="Invalid hex string"):
            hex_to_bytes("0x")

    def test_raises_for_odd_length(self) -> None:
        with pytest.raises(ValueError, match="Invalid hex string"):
            hex_to_bytes("0x123")

    def test_raises_for_invalid_characters(self) -> None:
        with pytest.raises(ValueError, match="Invalid hex string"):
            hex_to_bytes("0xGG")


class TestBytesToHex:
    def test_converts_bytes_to_hex(self) -> None:
        result = bytes_to_hex(bytes([1, 2, 3, 4, 5]))
        assert result == "0102030405"

    def test_handles_empty_bytes(self) -> None:
        result = bytes_to_hex(bytes([]))
        assert result == ""

    def test_pads_single_digit_bytes(self) -> None:
        result = bytes_to_hex(bytes([0, 1, 15, 16]))
        assert result == "00010f10"


class TestCalculateSha256:
    def test_calculates_hash_of_string(self) -> None:
        result = calculate_sha256("hello")
        assert isinstance(result, bytes)
        assert len(result) == 32

    def test_calculates_hash_of_bytes(self) -> None:
        result = calculate_sha256(b"hello")
        assert isinstance(result, bytes)
        assert len(result) == 32

    def test_produces_consistent_results(self) -> None:
        result1 = calculate_sha256("test")
        result2 = calculate_sha256("test")
        assert result1 == result2

    def test_produces_different_results_for_different_inputs(self) -> None:
        result1 = calculate_sha256("hello")
        result2 = calculate_sha256("world")
        assert result1 != result2


class TestGetTeeEndpoint:
    def test_returns_localhost_for_local(self) -> None:
        assert get_tee_endpoint("LOCAL") == "http://localhost:8090"

    def test_returns_docker_internal_for_docker(self) -> None:
        assert get_tee_endpoint("DOCKER") == "http://host.docker.internal:8090"

    def test_returns_none_for_production(self) -> None:
        assert get_tee_endpoint("PRODUCTION") is None

    def test_handles_case_insensitivity(self) -> None:
        assert get_tee_endpoint("local") == "http://localhost:8090"
        assert get_tee_endpoint("docker") == "http://host.docker.internal:8090"
        assert get_tee_endpoint("production") is None

    def test_raises_for_invalid_mode(self) -> None:
        with pytest.raises(ValueError, match="Invalid TEE_MODE"):
            get_tee_endpoint("INVALID")
