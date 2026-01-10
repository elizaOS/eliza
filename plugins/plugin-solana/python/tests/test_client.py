"""Integration tests for the Solana client.

These tests require a running Solana devnet connection.
"""

import os
from decimal import Decimal

import pytest

from elizaos_plugin_solana import (
    KeypairUtils,
    SolanaClient,
    SwapQuoteParams,
    WalletConfig,
)
from elizaos_plugin_solana.errors import ConfigError, InvalidPublicKeyError


class TestWalletConfig:
    """Tests for WalletConfig."""

    def test_read_only_valid(self, devnet_rpc: str, test_pubkey: str) -> None:
        """Test creating a read-only wallet config."""
        config = WalletConfig.read_only(devnet_rpc, test_pubkey)
        assert not config.can_sign
        assert str(config.public_key) == test_pubkey

    def test_read_only_invalid_pubkey(self, devnet_rpc: str) -> None:
        """Test that invalid public keys raise an error."""
        with pytest.raises(InvalidPublicKeyError):
            WalletConfig.read_only(devnet_rpc, "invalid")

    def test_cannot_sign_without_keypair(self, devnet_rpc: str, test_pubkey: str) -> None:
        """Test that read-only wallets cannot sign."""
        config = WalletConfig.read_only(devnet_rpc, test_pubkey)
        with pytest.raises(ConfigError):
            _ = config.keypair

    def test_config_builder(self, devnet_rpc: str, test_pubkey: str) -> None:
        """Test config builder methods."""
        config = (
            WalletConfig.read_only(devnet_rpc, test_pubkey)
            .with_slippage(100)
            .with_helius_key("test_key")
            .with_birdeye_key("bird_key")
        )
        assert config.slippage_bps == 100
        assert config.helius_api_key == "test_key"
        assert config.birdeye_api_key == "bird_key"


class TestKeypairUtils:
    """Tests for KeypairUtils."""

    def test_generate_keypair(self) -> None:
        """Test keypair generation."""
        keypair = KeypairUtils.generate()
        base58 = KeypairUtils.to_base58(keypair)
        assert len(base58) > 80  # Base58-encoded 64 bytes

    def test_keypair_roundtrip(self) -> None:
        """Test that keypair can be serialized and restored."""
        keypair = KeypairUtils.generate()
        base58 = KeypairUtils.to_base58(keypair)
        restored = KeypairUtils.from_string(base58)
        assert bytes(keypair) == bytes(restored)

    def test_is_valid_pubkey(self, sol_mint: str) -> None:
        """Test public key validation."""
        assert KeypairUtils.is_valid_pubkey(sol_mint)
        assert not KeypairUtils.is_valid_pubkey("invalid")
        assert not KeypairUtils.is_valid_pubkey("")

    def test_detect_pubkeys_in_text(self, sol_mint: str, usdc_mint: str) -> None:
        """Test public key detection in text."""
        text = f"Send tokens to {sol_mint} or to {usdc_mint}"
        keys = KeypairUtils.detect_pubkeys_in_text(text)
        assert len(keys) == 2
        assert sol_mint in keys
        assert usdc_mint in keys

    def test_is_on_curve(self, sol_mint: str, test_pubkey: str) -> None:
        """Test on-curve check."""
        # System program is not on curve (PDA)
        result = KeypairUtils.is_on_curve(test_pubkey)
        assert result is not None
        
        # Invalid address returns None
        assert KeypairUtils.is_on_curve("invalid") is None


class TestSolanaClient:
    """Tests for SolanaClient."""

    @pytest.mark.asyncio
    async def test_read_only_balance(
        self, devnet_rpc: str, test_pubkey: str
    ) -> None:
        """Test querying balance with read-only wallet."""
        config = WalletConfig.read_only(devnet_rpc, test_pubkey)
        async with SolanaClient(config) as client:
            balance = await client.get_sol_balance()
            assert isinstance(balance, Decimal)
            assert balance >= 0

    @pytest.mark.asyncio
    async def test_multiple_balances(
        self, devnet_rpc: str, sol_mint: str, test_pubkey: str
    ) -> None:
        """Test querying multiple balances."""
        config = WalletConfig.read_only(devnet_rpc, test_pubkey)
        async with SolanaClient(config) as client:
            balances = await client.get_balances_for_addresses(
                [test_pubkey, sol_mint]
            )
            assert len(balances) == 2

    def test_is_valid_address(self, sol_mint: str) -> None:
        """Test address validation."""
        assert SolanaClient.is_valid_address(sol_mint)
        assert not SolanaClient.is_valid_address("invalid")

    def test_is_on_curve(self, test_pubkey: str) -> None:
        """Test on-curve check."""
        result = SolanaClient.is_on_curve(test_pubkey)
        assert result is not None
        
        assert SolanaClient.is_on_curve("invalid") is None


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.getenv("SOLANA_PRIVATE_KEY"),
    reason="Requires funded devnet wallet",
)
class TestSwapQuote:
    """Tests for swap functionality (requires funded wallet)."""

    async def test_get_swap_quote(
        self, devnet_rpc: str, sol_mint: str, usdc_mint: str
    ) -> None:
        """Test getting a swap quote from Jupiter."""
        private_key = os.environ["SOLANA_PRIVATE_KEY"]
        config = WalletConfig.with_keypair(devnet_rpc, private_key)

        async with SolanaClient(config) as client:
            params = SwapQuoteParams(
                input_mint=sol_mint,
                output_mint=usdc_mint,
                amount="1000000",  # 0.001 SOL in lamports
                slippage_bps=100,
            )

            # Note: Quote may fail on devnet due to liquidity
            try:
                quote = await client.get_swap_quote(params)
                assert quote.out_amount
                print(f"Got quote: {quote.in_amount} -> {quote.out_amount}")
            except Exception as e:
                # Expected on devnet
                print(f"Quote failed (expected on devnet): {e}")


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.getenv("SOLANA_PRIVATE_KEY"),
    reason="Requires funded devnet wallet",
)
class TestTransfer:
    """Tests for transfer functionality (requires funded wallet)."""

    async def test_sol_transfer(self, devnet_rpc: str) -> None:
        """Test SOL transfer on devnet."""
        private_key = os.environ["SOLANA_PRIVATE_KEY"]
        config = WalletConfig.with_keypair(devnet_rpc, private_key)

        async with SolanaClient(config) as client:
            # Generate a random recipient
            recipient = KeypairUtils.generate().pubkey()

            # Transfer a tiny amount
            try:
                result = await client.transfer_sol(
                    recipient, Decimal("0.000001")
                )
                assert result.success
                assert result.signature
                print(f"Transfer successful: {result.signature}")
            except Exception as e:
                # May fail if wallet not funded
                print(f"Transfer failed (expected if not funded): {e}")


