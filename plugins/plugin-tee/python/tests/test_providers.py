"""Tests for TEE providers (DeriveKey and RemoteAttestation).

These tests validate provider metadata, error paths, and successful
operation using mocked HTTP clients.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from elizaos_plugin_tee.errors import AttestationError, KeyDerivationError
from elizaos_plugin_tee.providers.derive_key import (
    PhalaDeriveKeyProvider,
    get_derived_keys,
)
from elizaos_plugin_tee.providers.remote_attestation import (
    PhalaRemoteAttestationProvider,
    get_remote_attestation,
)
from elizaos_plugin_tee.types import RemoteAttestationQuote


# ===========================================================================
# PhalaRemoteAttestationProvider tests
# ===========================================================================


class TestPhalaRemoteAttestationProvider:
    def test_provider_creates_with_local_mode(self) -> None:
        provider = PhalaRemoteAttestationProvider("LOCAL")
        assert provider._client.endpoint == "http://localhost:8090"

    def test_provider_creates_with_docker_mode(self) -> None:
        provider = PhalaRemoteAttestationProvider("DOCKER")
        assert provider._client.endpoint == "http://host.docker.internal:8090"

    def test_provider_creates_with_production_mode(self) -> None:
        provider = PhalaRemoteAttestationProvider("PRODUCTION")
        # Production uses the default endpoint
        assert provider._client.endpoint == "https://api.phala.network/tee"

    def test_provider_raises_on_invalid_mode(self) -> None:
        with pytest.raises(ValueError, match="Invalid TEE_MODE"):
            PhalaRemoteAttestationProvider("INVALID")

    @pytest.mark.asyncio
    async def test_generate_attestation_calls_tdx_quote(self) -> None:
        provider = PhalaRemoteAttestationProvider("LOCAL")
        provider._client = AsyncMock()
        provider._client.tdx_quote.return_value = {"quote": "deadbeef"}

        quote = await provider.generate_attestation("test-report-data")

        provider._client.tdx_quote.assert_awaited_once_with("test-report-data", None)
        assert isinstance(quote, RemoteAttestationQuote)
        assert quote.quote == "deadbeef"
        assert quote.timestamp > 0

    @pytest.mark.asyncio
    async def test_generate_attestation_with_hash_algorithm(self) -> None:
        from elizaos_plugin_tee.types import TdxQuoteHashAlgorithm

        provider = PhalaRemoteAttestationProvider("LOCAL")
        provider._client = AsyncMock()
        provider._client.tdx_quote.return_value = {"quote": "cafe"}

        quote = await provider.generate_attestation(
            "data", hash_algorithm=TdxQuoteHashAlgorithm.SHA256
        )

        provider._client.tdx_quote.assert_awaited_once_with("data", "sha256")
        assert quote.quote == "cafe"

    @pytest.mark.asyncio
    async def test_generate_attestation_raises_attestation_error(self) -> None:
        provider = PhalaRemoteAttestationProvider("LOCAL")
        provider._client = AsyncMock()
        provider._client.tdx_quote.side_effect = RuntimeError("network timeout")

        with pytest.raises(AttestationError, match="network timeout"):
            await provider.generate_attestation("data")

    @pytest.mark.asyncio
    async def test_close_delegates_to_client(self) -> None:
        provider = PhalaRemoteAttestationProvider("LOCAL")
        provider._client = AsyncMock()

        await provider.close()

        provider._client.close.assert_awaited_once()


# ===========================================================================
# get_remote_attestation provider-function tests
# ===========================================================================


class TestGetRemoteAttestation:
    @pytest.mark.asyncio
    async def test_returns_not_configured_when_tee_mode_empty(self) -> None:
        result = await get_remote_attestation(
            tee_mode="",
            agent_id="a1",
            entity_id="e1",
            room_id="r1",
            content="hi",
        )
        assert result["data"] is None
        assert "TEE_MODE" in result["text"]

    @pytest.mark.asyncio
    async def test_returns_attestation_data_on_success(self) -> None:
        mock_quote = RemoteAttestationQuote(
            quote="aabbccdd" * 8,  # long enough to slice
            timestamp=1700000000000,
        )

        with patch(
            "elizaos_plugin_tee.providers.remote_attestation.PhalaRemoteAttestationProvider"
        ) as MockProvider:
            instance = AsyncMock()
            instance.generate_attestation.return_value = mock_quote
            instance.close = AsyncMock()
            MockProvider.return_value = instance

            result = await get_remote_attestation(
                tee_mode="LOCAL",
                agent_id="a1",
                entity_id="e1",
                room_id="r1",
                content="hello",
            )

        assert result["data"] is not None
        assert result["data"]["quote"] == mock_quote.quote
        assert result["data"]["timestamp"] == str(mock_quote.timestamp)
        assert result["values"]["quote"] == mock_quote.quote
        assert "Remote attestation:" in result["text"]

    @pytest.mark.asyncio
    async def test_raises_attestation_error_on_failure(self) -> None:
        with patch(
            "elizaos_plugin_tee.providers.remote_attestation.PhalaRemoteAttestationProvider"
        ) as MockProvider:
            instance = AsyncMock()
            instance.generate_attestation.side_effect = RuntimeError("fail")
            instance.close = AsyncMock()
            MockProvider.return_value = instance

            with pytest.raises(AttestationError):
                await get_remote_attestation(
                    tee_mode="LOCAL",
                    agent_id="a1",
                    entity_id="e1",
                    room_id="r1",
                    content="hello",
                )


# ===========================================================================
# PhalaDeriveKeyProvider tests
# ===========================================================================


class TestPhalaDeriveKeyProvider:
    def test_creates_with_local_mode(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        assert provider._client.endpoint == "http://localhost:8090"

    def test_creates_with_docker_mode(self) -> None:
        provider = PhalaDeriveKeyProvider("DOCKER")
        assert provider._client.endpoint == "http://host.docker.internal:8090"

    def test_raises_on_invalid_mode(self) -> None:
        with pytest.raises(ValueError, match="Invalid TEE_MODE"):
            PhalaDeriveKeyProvider("BOGUS")

    @pytest.mark.asyncio
    async def test_raw_derive_key_rejects_empty_path(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        with pytest.raises(KeyDerivationError):
            await provider.raw_derive_key("", "subject")

    @pytest.mark.asyncio
    async def test_raw_derive_key_rejects_empty_subject(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        with pytest.raises(KeyDerivationError):
            await provider.raw_derive_key("/path", "")

    @pytest.mark.asyncio
    async def test_derive_ed25519_rejects_empty_path(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        with pytest.raises(KeyDerivationError):
            await provider.derive_ed25519_keypair("", "subject", "agent-1")

    @pytest.mark.asyncio
    async def test_derive_ed25519_rejects_empty_subject(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        with pytest.raises(KeyDerivationError):
            await provider.derive_ed25519_keypair("/path", "", "agent-1")

    @pytest.mark.asyncio
    async def test_derive_ecdsa_rejects_empty_path(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        with pytest.raises(KeyDerivationError):
            await provider.derive_ecdsa_keypair("", "subject", "agent-1")

    @pytest.mark.asyncio
    async def test_derive_ecdsa_rejects_empty_subject(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        with pytest.raises(KeyDerivationError):
            await provider.derive_ecdsa_keypair("/path", "", "agent-1")

    @pytest.mark.asyncio
    async def test_raw_derive_key_success(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        provider._client = AsyncMock()
        provider._client.derive_key.return_value = b"\x01\x02\x03\x04" * 8

        result = await provider.raw_derive_key("/my/path", "my-subject")

        provider._client.derive_key.assert_awaited_once_with("/my/path", "my-subject")
        assert result.key == b"\x01\x02\x03\x04" * 8
        assert result.certificate_chain == []

    @pytest.mark.asyncio
    async def test_raw_derive_key_wraps_client_error(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        provider._client = AsyncMock()
        provider._client.derive_key.side_effect = RuntimeError("http 500")

        with pytest.raises(KeyDerivationError, match="http 500"):
            await provider.raw_derive_key("/path", "subject")

    @pytest.mark.asyncio
    async def test_derive_ed25519_returns_keypair_result(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        provider._client = AsyncMock()
        # Return 32 bytes of key material
        provider._client.derive_key.return_value = b"\xab" * 32

        mock_quote = RemoteAttestationQuote(quote="abcdef", timestamp=100)
        provider._ra_provider = AsyncMock()
        provider._ra_provider.generate_attestation.return_value = mock_quote

        result = await provider.derive_ed25519_keypair("/salt", "solana", "agent-1")

        assert result.public_key  # non-empty base58 public key
        assert len(result.secret_key) > 0
        assert result.attestation.quote == "abcdef"

    @pytest.mark.asyncio
    async def test_derive_ecdsa_returns_keypair_result(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        provider._client = AsyncMock()
        provider._client.derive_key.return_value = b"\xcd" * 32

        mock_quote = RemoteAttestationQuote(quote="deadbeef", timestamp=200)
        provider._ra_provider = AsyncMock()
        provider._ra_provider.generate_attestation.return_value = mock_quote

        result = await provider.derive_ecdsa_keypair("/salt", "evm", "agent-1")

        assert result.address.startswith("0x")
        assert len(result.private_key) == 32
        assert result.attestation.quote == "deadbeef"

    @pytest.mark.asyncio
    async def test_close_closes_both_clients(self) -> None:
        provider = PhalaDeriveKeyProvider("LOCAL")
        provider._client = AsyncMock()
        provider._ra_provider = AsyncMock()

        await provider.close()

        provider._client.close.assert_awaited_once()
        provider._ra_provider.close.assert_awaited_once()


# ===========================================================================
# get_derived_keys provider-function tests
# ===========================================================================


class TestGetDerivedKeys:
    @pytest.mark.asyncio
    async def test_returns_not_configured_when_tee_mode_empty(self) -> None:
        result = await get_derived_keys(tee_mode="", secret_salt="salt", agent_id="a1")
        assert result["data"] is None
        assert "TEE_MODE" in result["text"]

    @pytest.mark.asyncio
    async def test_returns_not_configured_when_salt_empty(self) -> None:
        result = await get_derived_keys(tee_mode="LOCAL", secret_salt="", agent_id="a1")
        assert result["data"] is None
        assert "WALLET_SECRET_SALT" in result["text"]

    @pytest.mark.asyncio
    async def test_returns_wallet_data_on_success(self) -> None:
        mock_quote = RemoteAttestationQuote(quote="ff", timestamp=0)

        with patch(
            "elizaos_plugin_tee.providers.derive_key.PhalaDeriveKeyProvider"
        ) as MockProvider:
            instance = AsyncMock()

            # Mock Ed25519 keypair result
            ed25519_result = AsyncMock()
            ed25519_result.public_key = "SolPubKey123"

            # Mock ECDSA keypair result
            ecdsa_result = AsyncMock()
            ecdsa_result.address = "0xEVMAddress456"

            instance.derive_ed25519_keypair.return_value = ed25519_result
            instance.derive_ecdsa_keypair.return_value = ecdsa_result
            instance.close = AsyncMock()
            MockProvider.return_value = instance

            result = await get_derived_keys(
                tee_mode="LOCAL", secret_salt="my-salt", agent_id="agent-1"
            )

        assert result["data"] is not None
        assert result["data"]["solana"] == "SolPubKey123"
        assert result["data"]["evm"] == "0xEVMAddress456"
        assert result["values"]["solana_public_key"] == "SolPubKey123"
        assert result["values"]["evm_address"] == "0xEVMAddress456"
        assert "SolPubKey123" in result["text"]
        assert "0xEVMAddress456" in result["text"]

    @pytest.mark.asyncio
    async def test_returns_failure_text_on_derivation_error(self) -> None:
        with patch(
            "elizaos_plugin_tee.providers.derive_key.PhalaDeriveKeyProvider"
        ) as MockProvider:
            instance = AsyncMock()
            instance.derive_ed25519_keypair.side_effect = RuntimeError("derive failed")
            instance.close = AsyncMock()
            MockProvider.return_value = instance

            result = await get_derived_keys(
                tee_mode="LOCAL", secret_salt="salt", agent_id="agent-1"
            )

        assert result["data"] is None
        assert "Failed to derive keys" in result["text"]

    @pytest.mark.asyncio
    async def test_provider_is_closed_on_success(self) -> None:
        with patch(
            "elizaos_plugin_tee.providers.derive_key.PhalaDeriveKeyProvider"
        ) as MockProvider:
            instance = AsyncMock()
            ed_result = AsyncMock()
            ed_result.public_key = "pk"
            ec_result = AsyncMock()
            ec_result.address = "0x123"
            instance.derive_ed25519_keypair.return_value = ed_result
            instance.derive_ecdsa_keypair.return_value = ec_result
            instance.close = AsyncMock()
            MockProvider.return_value = instance

            await get_derived_keys(tee_mode="LOCAL", secret_salt="s", agent_id="a")

        instance.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_provider_is_closed_on_error(self) -> None:
        with patch(
            "elizaos_plugin_tee.providers.derive_key.PhalaDeriveKeyProvider"
        ) as MockProvider:
            instance = AsyncMock()
            instance.derive_ed25519_keypair.side_effect = RuntimeError("boom")
            instance.close = AsyncMock()
            MockProvider.return_value = instance

            await get_derived_keys(tee_mode="LOCAL", secret_salt="s", agent_id="a")

        instance.close.assert_awaited_once()
