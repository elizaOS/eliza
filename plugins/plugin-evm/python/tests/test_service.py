"""
Tests for EVMService — wallet data caching, refresh, and lifecycle.

All tests run without real Ethereum wallets or RPC connections.
"""

from __future__ import annotations

from time import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_evm.constants import CACHE_REFRESH_INTERVAL_SECS, EVM_SERVICE_NAME
from elizaos_plugin_evm.service import EVMService, EvmWalletChainData, EvmWalletData
from elizaos_plugin_evm.types import SupportedChain, WalletBalance


# ─── Dataclass Construction Tests ────────────────────────────────────────────


class TestEvmWalletChainData:
    def test_construction(self) -> None:
        data = EvmWalletChainData(
            chain_name="mainnet",
            name="mainnet",
            balance="1.5",
            symbol="ETH",
            chain_id=1,
        )
        assert data.chain_name == "mainnet"
        assert data.name == "mainnet"
        assert data.balance == "1.5"
        assert data.symbol == "ETH"
        assert data.chain_id == 1

    def test_frozen(self) -> None:
        data = EvmWalletChainData(
            chain_name="mainnet", name="mainnet",
            balance="1.0", symbol="ETH", chain_id=1,
        )
        with pytest.raises(AttributeError):
            data.balance = "2.0"  # type: ignore[misc]


class TestEvmWalletData:
    def test_construction(self) -> None:
        chain_data = EvmWalletChainData(
            chain_name="mainnet", name="mainnet",
            balance="1.5", symbol="ETH", chain_id=1,
        )
        data = EvmWalletData(
            address="0x1234567890123456789012345678901234567890",
            chains=(chain_data,),
            timestamp=1700000000000,
        )
        assert data.address.startswith("0x")
        assert len(data.chains) == 1
        assert data.chains[0].chain_name == "mainnet"
        assert data.timestamp == 1700000000000

    def test_empty_chains(self) -> None:
        data = EvmWalletData(
            address="0x1234567890123456789012345678901234567890",
            chains=(),
            timestamp=1700000000000,
        )
        assert len(data.chains) == 0

    def test_multiple_chains(self) -> None:
        c1 = EvmWalletChainData(
            chain_name="mainnet", name="mainnet",
            balance="1.0", symbol="ETH", chain_id=1,
        )
        c2 = EvmWalletChainData(
            chain_name="base", name="base",
            balance="0.5", symbol="ETH", chain_id=8453,
        )
        data = EvmWalletData(
            address="0x1234567890123456789012345678901234567890",
            chains=(c1, c2),
            timestamp=1700000000000,
        )
        assert len(data.chains) == 2


# ─── EVMService Tests ────────────────────────────────────────────────────────


def _mock_wallet_provider(address: str = "0xABCD1234ABCD1234ABCD1234ABCD1234ABCD1234") -> MagicMock:
    """Build a mocked EVMWalletProvider."""
    provider = MagicMock()
    provider.address = address

    async def _get_balance(chain: SupportedChain) -> WalletBalance:
        return WalletBalance(
            chain=chain,
            address=address,
            native_balance="1.5",
            tokens=[],
        )

    provider.get_balance = AsyncMock(side_effect=_get_balance)
    return provider


class TestEVMServiceMeta:
    def test_service_type(self) -> None:
        assert EVMService.service_type == EVM_SERVICE_NAME

    def test_capability_description(self) -> None:
        assert "EVM" in EVMService.capability_description


class TestEVMServiceInit:
    def test_creation(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)
        assert service.wallet_provider is provider
        assert service._cached is None


class TestEVMServiceRefresh:
    @pytest.mark.asyncio
    async def test_refresh_populates_cache(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)

        await service.refresh_wallet_data()

        assert service._cached is not None
        assert service._cached.address == provider.address
        # Default chains are mainnet and base
        assert len(service._cached.chains) == 2
        chain_names = {c.chain_name for c in service._cached.chains}
        assert "mainnet" in chain_names
        assert "base" in chain_names

    @pytest.mark.asyncio
    async def test_refresh_calls_get_balance(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)

        await service.refresh_wallet_data()

        assert provider.get_balance.call_count == 2  # mainnet + base

    @pytest.mark.asyncio
    async def test_refresh_chain_data_fields(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)

        await service.refresh_wallet_data()

        assert service._cached is not None
        mainnet_data = next(
            c for c in service._cached.chains if c.chain_name == "mainnet"
        )
        assert mainnet_data.balance == "1.5"
        assert mainnet_data.symbol == "ETH"
        assert mainnet_data.chain_id == 1

    @pytest.mark.asyncio
    async def test_refresh_sets_timestamp(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)

        before_ms = int(time() * 1000)
        await service.refresh_wallet_data()
        after_ms = int(time() * 1000)

        assert service._cached is not None
        assert before_ms <= service._cached.timestamp <= after_ms


class TestEVMServiceCache:
    @pytest.mark.asyncio
    async def test_get_cached_data_returns_none_when_empty(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)
        result = await service.get_cached_data()
        assert result is None

    @pytest.mark.asyncio
    async def test_get_cached_data_returns_data_when_fresh(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)
        await service.refresh_wallet_data()

        result = await service.get_cached_data()
        assert result is not None
        assert result.address == provider.address

    @pytest.mark.asyncio
    async def test_get_cached_data_returns_none_when_expired(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)
        await service.refresh_wallet_data()

        # Backdate the timestamp so it looks expired
        assert service._cached is not None
        expired_ts = int(time() * 1000) - (CACHE_REFRESH_INTERVAL_SECS + 1) * 1000
        # Replace the cached data with an expired version
        service._cached = EvmWalletData(
            address=service._cached.address,
            chains=service._cached.chains,
            timestamp=expired_ts,
        )

        result = await service.get_cached_data()
        assert result is None


class TestEVMServiceForceUpdate:
    @pytest.mark.asyncio
    async def test_force_update_refreshes(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)

        result = await service.force_update()
        assert result is not None
        assert result.address == provider.address

    @pytest.mark.asyncio
    async def test_force_update_after_stop(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)
        await service.stop()

        result = await service.force_update()
        assert result is not None  # Should re-populate


class TestEVMServiceStop:
    @pytest.mark.asyncio
    async def test_stop_clears_cache(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)
        await service.refresh_wallet_data()

        assert service._cached is not None
        await service.stop()
        assert service._cached is None

    @pytest.mark.asyncio
    async def test_stop_idempotent(self) -> None:
        provider = _mock_wallet_provider()
        service = EVMService(provider)
        await service.stop()
        await service.stop()  # Should not raise


class TestEVMServiceStart:
    @pytest.mark.asyncio
    async def test_start_creates_service(self) -> None:
        """EVMService.start() auto-generates a wallet and refreshes."""
        # Patch the wallet provider to avoid real RPC calls
        with patch(
            "elizaos_plugin_evm.service.EVMWalletProvider"
        ) as MockProvider:
            mock_instance = _mock_wallet_provider()
            MockProvider.return_value = mock_instance

            service = await EVMService.start(private_key=None)

        assert service.wallet_provider is mock_instance
        assert service._cached is not None
