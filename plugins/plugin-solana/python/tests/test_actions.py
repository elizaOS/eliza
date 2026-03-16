"""Tests for Solana plugin actions."""

from decimal import Decimal

import pytest

from elizaos_plugin_solana.actions import (
    SWAP_ACTION,
    TRANSFER_ACTION,
    SwapActionResult,
    TransferActionResult,
)
from elizaos_plugin_solana.actions.swap import resolve_sol_mint


class TestSwapAction:
    def test_action_metadata(self) -> None:
        assert SWAP_ACTION["name"] == "SWAP_SOLANA"
        assert SWAP_ACTION["description"]
        assert "SWAP_SOL" in SWAP_ACTION["similes"]

    def test_resolve_sol_mint(self) -> None:
        sol_mint = "So11111111111111111111111111111111111111112"
        usdc_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

        assert resolve_sol_mint("SOL") == sol_mint
        assert resolve_sol_mint("sol") == sol_mint
        assert resolve_sol_mint(usdc_mint) == usdc_mint

    def test_swap_action_result_dataclass(self) -> None:
        result = SwapActionResult(
            success=True,
            text="Swap completed",
            signature="test_sig",
            in_amount="1000",
            out_amount="500",
        )
        assert result.success
        assert result.signature == "test_sig"
        assert result.error is None


class TestTransferAction:
    def test_action_metadata(self) -> None:
        assert TRANSFER_ACTION["name"] == "TRANSFER_SOLANA"
        assert TRANSFER_ACTION["description"]
        assert "SEND_SOL" in TRANSFER_ACTION["similes"]
        assert "PAY_SOLANA" in TRANSFER_ACTION["similes"]

    def test_transfer_action_result_dataclass(self) -> None:
        result = TransferActionResult(
            success=True,
            text="Transfer completed",
            signature="test_sig",
            amount="1.5",
            recipient="test_recipient",
        )
        assert result.success
        assert result.amount == "1.5"
        assert result.error is None


@pytest.mark.skipif(
    True,
    reason="Requires funded Solana wallet",
)
class TestSwapActionIntegration:
    @pytest.mark.asyncio
    async def test_swap_with_invalid_mint(self) -> None:
        from elizaos_plugin_solana import SolanaClient, WalletConfig
        from elizaos_plugin_solana.actions.swap import handle_swap

        config = WalletConfig.read_only(
            "https://api.devnet.solana.com",
            "11111111111111111111111111111111",
        )
        async with SolanaClient(config) as client:
            result = await handle_swap(
                client,
                "invalid_mint",
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                Decimal("1.0"),
            )
            assert not result.success
            assert "Invalid input mint" in result.text


@pytest.mark.skipif(
    True,
    reason="Requires funded Solana wallet",
)
class TestTransferActionIntegration:
    @pytest.mark.asyncio
    async def test_transfer_with_invalid_recipient(self) -> None:
        from elizaos_plugin_solana import SolanaClient, WalletConfig
        from elizaos_plugin_solana.actions.transfer import handle_transfer

        config = WalletConfig.read_only(
            "https://api.devnet.solana.com",
            "11111111111111111111111111111111",
        )
        async with SolanaClient(config) as client:
            result = await handle_transfer(
                client,
                None,  # SOL transfer
                "invalid_recipient",
                Decimal("1.0"),
            )
            assert not result.success
            assert "Invalid recipient" in result.text
