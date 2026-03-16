"""Tests for Solana plugin providers."""

import pytest

from elizaos_plugin_solana.providers import (
    WALLET_PROVIDER,
    WalletProviderResult,
)


class TestWalletProvider:
    def test_provider_metadata(self) -> None:
        assert WALLET_PROVIDER["name"] == "solana-wallet"
        assert WALLET_PROVIDER["description"]
        assert WALLET_PROVIDER["dynamic"] is True

    def test_wallet_provider_result_dataclass(self) -> None:
        from elizaos_plugin_solana.types import WalletPortfolio

        portfolio = WalletPortfolio(
            total_usd="100.00",
            total_sol="1.0",
            items=[],
        )

        result = WalletProviderResult(
            data=portfolio,
            values={"total_usd": "100.00"},
            text="Test wallet",
        )

        assert result.data.total_usd == "100.00"
        assert result.values["total_usd"] == "100.00"
        assert "Test wallet" in result.text


# Integration tests - skip unless explicitly enabled
@pytest.mark.skipif(
    True,  # Always skip in CI - requires RPC access
    reason="Requires Solana RPC access",
)
class TestWalletProviderIntegration:
    """Integration tests for wallet provider."""

    @pytest.mark.asyncio
    async def test_get_wallet_portfolio(self) -> None:
        """Test fetching wallet portfolio."""
        from elizaos_plugin_solana import SolanaClient, WalletConfig
        from elizaos_plugin_solana.providers.wallet import get_wallet_portfolio

        config = WalletConfig.read_only(
            "https://api.devnet.solana.com",
            "11111111111111111111111111111111",
        )
        async with SolanaClient(config) as client:
            result = await get_wallet_portfolio(client, "Test Agent")

            assert result.text
            assert "Test Agent" in result.text
            assert "total_usd" in result.values
            assert "total_sol" in result.values
            assert result.data.items is not None
