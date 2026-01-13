from __future__ import annotations

from dataclasses import dataclass
from time import time

from elizaos_plugin_polymarket.constants import (
    CACHE_REFRESH_INTERVAL_SECS,
    POLYGON_CHAIN_ID,
    POLYMARKET_SERVICE_NAME,
)
from elizaos_plugin_polymarket.providers.clob import ClobClientProvider, RuntimeProtocol


@dataclass(frozen=True)
class PolymarketWalletData:
    address: str
    chain_id: int
    timestamp: int


class PolymarketService:
    """
    Minimal service wrapper for Polymarket (TS parity: `PolymarketService`).

    This is intentionally lightweight: it exposes CLOB clients and caches wallet metadata.
    """

    service_type: str = POLYMARKET_SERVICE_NAME
    capability_description: str = "Polymarket CLOB access and trading utilities"

    def __init__(self, runtime: RuntimeProtocol | None = None) -> None:
        self._provider = ClobClientProvider(runtime)
        self._cached_wallet: PolymarketWalletData | None = None

    @property
    def provider(self) -> ClobClientProvider:
        return self._provider

    def client(self) -> object:
        return self._provider.get_client()

    def authenticated_client(self) -> object:
        return self._provider.get_authenticated_client()

    def has_credentials(self) -> bool:
        return self._provider.has_credentials()

    def refresh_wallet_data(self) -> PolymarketWalletData:
        address = self._provider.get_wallet_address()
        self._cached_wallet = PolymarketWalletData(
            address=address,
            chain_id=POLYGON_CHAIN_ID,
            timestamp=int(time() * 1000),
        )
        return self._cached_wallet

    def get_cached_wallet_data(self) -> PolymarketWalletData | None:
        if self._cached_wallet is None:
            return None

        age_ms = int(time() * 1000) - self._cached_wallet.timestamp
        max_age_ms = int(CACHE_REFRESH_INTERVAL_SECS * 1000)
        if age_ms > max_age_ms:
            return None

        return self._cached_wallet

    def stop(self) -> None:
        self._cached_wallet = None
