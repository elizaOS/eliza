"""
Tests for EVM providers — wallet provider and balance providers.

All tests run without real Ethereum wallets or RPC connections.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_evm.error import EVMError, EVMErrorCode
from elizaos_plugin_evm.providers.get_balance import (
    ProviderResult,
    TokenBalanceProvider,
    parse_key_value_xml,
)
from elizaos_plugin_evm.providers.wallet import (
    EVMWalletProvider,
    GeneratedKey,
    generate_private_key,
)


# ─── GeneratedKey ────────────────────────────────────────────────────────────


class TestGeneratedKey:
    def test_structure(self) -> None:
        key = GeneratedKey(
            private_key="0x" + "ab" * 32,
            address="0x1234567890123456789012345678901234567890",
        )
        assert key.private_key.startswith("0x")
        assert key.address.startswith("0x")


# ─── generate_private_key ────────────────────────────────────────────────────


class TestGeneratePrivateKey:
    def test_returns_valid_key(self) -> None:
        result = generate_private_key()
        assert isinstance(result, GeneratedKey)
        assert result.private_key.startswith("0x")
        assert len(result.private_key) == 66  # 0x + 64 hex chars
        assert result.address.startswith("0x")
        assert len(result.address) == 42

    def test_generates_unique_keys(self) -> None:
        k1 = generate_private_key()
        k2 = generate_private_key()
        assert k1.private_key != k2.private_key
        assert k1.address != k2.address


# ─── EVMWalletProvider — auto-generation ─────────────────────────────────────


class TestEVMWalletProviderAutoGen:
    def test_auto_generates_when_none(self) -> None:
        provider = EVMWalletProvider(None)
        assert provider.was_auto_generated is True
        assert provider.generated_key is not None
        assert provider.generated_key.private_key.startswith("0x")
        assert len(provider.generated_key.private_key) == 66
        assert provider.generated_key.address.startswith("0x")
        assert len(provider.generated_key.address) == 42

    def test_auto_generates_when_empty(self) -> None:
        provider = EVMWalletProvider("")
        assert provider.was_auto_generated is True
        assert provider.generated_key is not None

    def test_address_matches_generated(self) -> None:
        provider = EVMWalletProvider(None)
        assert provider.generated_key is not None
        assert provider.address == provider.generated_key.address


# ─── EVMWalletProvider — provided key ────────────────────────────────────────


class TestEVMWalletProviderWithKey:
    def _get_valid_key(self) -> str:
        gen = generate_private_key()
        return gen.private_key

    def test_not_auto_generated(self) -> None:
        key = self._get_valid_key()
        provider = EVMWalletProvider(key)
        assert provider.was_auto_generated is False
        assert provider.generated_key is None

    def test_address_is_valid(self) -> None:
        key = self._get_valid_key()
        provider = EVMWalletProvider(key)
        assert provider.address.startswith("0x")
        assert len(provider.address) == 42

    def test_key_without_0x_prefix(self) -> None:
        """Provider auto-adds 0x prefix if missing."""
        gen = generate_private_key()
        key_no_prefix = gen.private_key[2:]  # strip 0x
        provider = EVMWalletProvider(key_no_prefix)
        assert provider.address == gen.address

    def test_same_key_same_address(self) -> None:
        key = self._get_valid_key()
        p1 = EVMWalletProvider(key)
        p2 = EVMWalletProvider(key)
        assert p1.address == p2.address


# ─── EVMWalletProvider — invalid key ─────────────────────────────────────────


class TestEVMWalletProviderInvalidKey:
    def test_invalid_key_raises(self) -> None:
        with pytest.raises(EVMError) as exc:
            EVMWalletProvider("invalid_key")
        assert exc.value.code == EVMErrorCode.INVALID_PARAMS

    def test_too_short_key_raises(self) -> None:
        with pytest.raises(EVMError) as exc:
            EVMWalletProvider("0x1234")
        assert exc.value.code == EVMErrorCode.INVALID_PARAMS

    def test_non_hex_key_raises(self) -> None:
        with pytest.raises(EVMError) as exc:
            EVMWalletProvider("0x" + "GG" * 32)
        assert exc.value.code == EVMErrorCode.INVALID_PARAMS


# ─── parse_key_value_xml ─────────────────────────────────────────────────────


class TestParseKeyValueXml:
    def test_parses_token_and_chain(self) -> None:
        xml = "<response><token>ETH</token><chain>mainnet</chain></response>"
        result = parse_key_value_xml(xml)
        assert result["token"] == "ETH"
        assert result["chain"] == "mainnet"

    def test_parses_error(self) -> None:
        xml = "<response><error>true</error></response>"
        result = parse_key_value_xml(xml)
        assert result["error"] == "true"

    def test_strips_whitespace(self) -> None:
        xml = "<response><token> USDC </token><chain> base </chain></response>"
        result = parse_key_value_xml(xml)
        assert result["token"] == "USDC"
        assert result["chain"] == "base"

    def test_empty_xml_returns_empty(self) -> None:
        result = parse_key_value_xml("")
        assert result == {}

    def test_no_matching_tags(self) -> None:
        result = parse_key_value_xml("no xml here at all")
        assert result == {}


# ─── ProviderResult ──────────────────────────────────────────────────────────


class TestProviderResult:
    def test_construction(self) -> None:
        pr = ProviderResult(
            text="ETH balance: 1.5",
            data={"token": "ETH", "balance": "1.5"},
            values={"token": "ETH"},
        )
        assert pr.text == "ETH balance: 1.5"
        assert pr.data["token"] == "ETH"
        assert pr.values["token"] == "ETH"

    def test_empty_result(self) -> None:
        pr = ProviderResult(text="", data={}, values={})
        assert pr.text == ""
        assert pr.data == {}


# ─── TokenBalanceProvider ────────────────────────────────────────────────────


class TestTokenBalanceProvider:
    def test_metadata(self) -> None:
        provider = TokenBalanceProvider()
        assert provider.name == "TOKEN_BALANCE"
        assert provider.dynamic is True
        assert len(provider.description) > 0

    @pytest.mark.asyncio
    async def test_empty_message_returns_empty(self) -> None:
        provider = TokenBalanceProvider()
        runtime = AsyncMock()
        message: dict[str, object] = {"content": {"text": ""}}
        wallet = MagicMock()

        result = await provider.get(runtime, message, wallet)
        assert result.text == ""

    @pytest.mark.asyncio
    async def test_no_content_returns_empty(self) -> None:
        provider = TokenBalanceProvider()
        runtime = AsyncMock()
        message: dict[str, object] = {}
        wallet = MagicMock()

        result = await provider.get(runtime, message, wallet)
        assert result.text == ""

    @pytest.mark.asyncio
    async def test_error_response_returns_empty(self) -> None:
        provider = TokenBalanceProvider()
        runtime = AsyncMock()
        runtime.use_model = AsyncMock(
            return_value="<response><error>true</error></response>"
        )
        message: dict[str, object] = {"content": {"text": "check my balance"}}
        wallet = MagicMock()

        result = await provider.get(runtime, message, wallet)
        assert result.text == ""

    @pytest.mark.asyncio
    async def test_valid_response_formats_output(self) -> None:
        provider = TokenBalanceProvider()
        runtime = AsyncMock()
        runtime.use_model = AsyncMock(
            return_value="<response><token>ETH</token><chain>mainnet</chain></response>"
        )
        message: dict[str, object] = {"content": {"text": "what is my ETH balance on mainnet"}}
        wallet = MagicMock()
        wallet.chains = ["mainnet"]
        wallet.get_address.return_value = "0x1234567890123456789012345678901234567890"

        result = await provider.get(runtime, message, wallet)
        assert "ETH" in result.text
        assert "mainnet" in result.text

    @pytest.mark.asyncio
    async def test_unconfigured_chain_reports_error(self) -> None:
        provider = TokenBalanceProvider()
        runtime = AsyncMock()
        runtime.use_model = AsyncMock(
            return_value="<response><token>MATIC</token><chain>polygon</chain></response>"
        )
        message: dict[str, object] = {"content": {"text": "MATIC balance on polygon"}}
        wallet = MagicMock()
        wallet.chains = ["mainnet"]  # polygon not configured

        result = await provider.get(runtime, message, wallet)
        assert "not configured" in result.text
