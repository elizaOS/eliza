from __future__ import annotations

from dataclasses import dataclass
from time import time

from elizaos_plugin_evm.constants import (
    CACHE_REFRESH_INTERVAL_SECS,
    DEFAULT_CHAINS,
    EVM_SERVICE_NAME,
)
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import SupportedChain


@dataclass(frozen=True)
class EvmWalletChainData:
    chain_name: str
    name: str
    balance: str
    symbol: str
    chain_id: int


@dataclass(frozen=True)
class EvmWalletData:
    address: str
    chains: tuple[EvmWalletChainData, ...]
    timestamp: int


class EVMService:
    """
    Lightweight service wrapper for EVM wallet access (TS parity: `EVMService`).

    This implementation is intentionally minimal and does not depend on an elizaOS runtime;
    it caches balances in-memory and can be used by higher-level integrations.
    """

    service_type: str = EVM_SERVICE_NAME
    capability_description: str = "EVM blockchain wallet access"

    def __init__(self, wallet_provider: EVMWalletProvider) -> None:
        self._wallet_provider = wallet_provider
        self._cached: EvmWalletData | None = None

    @classmethod
    async def start(cls, private_key: str | None = None) -> EVMService:
        provider = EVMWalletProvider(private_key=private_key)
        service = cls(provider)
        await service.refresh_wallet_data()
        return service

    async def stop(self) -> None:
        self._cached = None

    @property
    def wallet_provider(self) -> EVMWalletProvider:
        return self._wallet_provider

    async def refresh_wallet_data(self) -> None:
        chains: list[EvmWalletChainData] = []

        for chain_name in DEFAULT_CHAINS:
            try:
                chain = SupportedChain(chain_name)
            except ValueError:  # Invalid enum value
                # Skip invalid configuration entries
                continue

            balance = await self._wallet_provider.get_balance(chain)
            chains.append(
                EvmWalletChainData(
                    chain_name=chain.value,
                    name=chain.value,
                    balance=balance.native_balance,
                    symbol=chain.native_symbol,
                    chain_id=chain.chain_id,
                )
            )

        self._cached = EvmWalletData(
            address=self._wallet_provider.address,
            chains=tuple(chains),
            timestamp=int(time() * 1000),
        )

    async def get_cached_data(self) -> EvmWalletData | None:
        if self._cached is None:
            return None

        age_ms = int(time() * 1000) - self._cached.timestamp
        max_age_ms = int(CACHE_REFRESH_INTERVAL_SECS * 1000)
        if age_ms > max_age_ms:
            return None

        return self._cached

    async def force_update(self) -> EvmWalletData | None:
        await self.refresh_wallet_data()
        return await self.get_cached_data()
