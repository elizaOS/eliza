from __future__ import annotations

from elizaos_plugin_solana.client import SolanaClient
from elizaos_plugin_solana.config import WalletConfig
from elizaos_plugin_solana.providers.wallet import WalletProviderResult, get_wallet_portfolio


class SolanaService:
    """
    Minimal service wrapper for Solana (TS parity: `SolanaService`).
    """

    service_type: str = "chain_solana"
    capability_description: str = "The agent is able to interact with the Solana blockchain, and has access to the wallet data"

    def __init__(self, client: SolanaClient) -> None:
        self._client = client

    @classmethod
    def from_env_or_generate(cls) -> SolanaService:
        config = WalletConfig.from_env_or_generate()
        return cls(SolanaClient(config))

    @property
    def client(self) -> SolanaClient:
        return self._client

    async def get_wallet_portfolio(self, agent_name: str | None = None) -> WalletProviderResult:
        return await get_wallet_portfolio(self._client, agent_name=agent_name)


class SolanaWalletService:
    """
    Minimal wallet service wrapper (TS parity: `SolanaWalletService`).
    """

    service_type: str = "WALLET"
    capability_description: str = (
        "Provides standardized access to Solana wallet balances and portfolios."
    )

    def __init__(self, solana: SolanaService) -> None:
        self._solana = solana

    @property
    def solana_service(self) -> SolanaService:
        return self._solana
