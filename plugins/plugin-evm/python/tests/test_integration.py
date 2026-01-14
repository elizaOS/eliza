"""
Integration tests for the EVM plugin against live testnets.

These tests require (for network tests):
- EVM_PRIVATE_KEY environment variable set with a funded testnet wallet
- Network connectivity to RPC endpoints

Auto-generation tests can run without an EVM_PRIVATE_KEY.

Run with: pytest tests/test_integration.py -v
"""

import os

import pytest

from elizaos_plugin_evm import (
    BridgeParams,
    EVMWalletProvider,
    SupportedChain,
    SwapParams,
    TransferParams,
    execute_transfer,
)
from elizaos_plugin_evm.error import EVMError

pytestmark = pytest.mark.integration

# Mark for tests that require the private key
requires_private_key = pytest.mark.skipif(
    not os.getenv("EVM_PRIVATE_KEY"),
    reason="EVM_PRIVATE_KEY not set",
)


@pytest.fixture
def private_key() -> str:
    """Get the private key from environment."""
    key = os.getenv("EVM_PRIVATE_KEY")
    if not key:
        pytest.skip("EVM_PRIVATE_KEY not set")
    return key


@pytest.fixture
def provider(private_key: str) -> EVMWalletProvider:
    """Create a wallet provider."""
    return EVMWalletProvider(private_key)


@requires_private_key
class TestWalletProvider:
    """Integration tests for the wallet provider."""

    @pytest.mark.asyncio
    async def test_get_address(self, provider: EVMWalletProvider):
        """Test that address is valid."""
        address = provider.address
        assert address.startswith("0x")
        assert len(address) == 42

    @pytest.mark.asyncio
    async def test_get_balance_mainnet(self, provider: EVMWalletProvider):
        """Test getting balance on mainnet."""
        balance = await provider.get_balance(SupportedChain.MAINNET)
        assert balance.chain == SupportedChain.MAINNET
        assert balance.address == provider.address
        # Balance should be a valid decimal string
        float(balance.native_balance)

    @pytest.mark.asyncio
    async def test_get_balance_sepolia(self, provider: EVMWalletProvider):
        """Test getting balance on Sepolia testnet."""
        balance = await provider.get_balance(SupportedChain.SEPOLIA)
        assert balance.chain == SupportedChain.SEPOLIA
        assert balance.address == provider.address

    @pytest.mark.asyncio
    async def test_get_balance_multiple_chains(self, provider: EVMWalletProvider):
        """Test getting balance on multiple chains."""
        chains = [
            SupportedChain.MAINNET,
            SupportedChain.BASE,
            SupportedChain.ARBITRUM,
        ]
        for chain in chains:
            balance = await provider.get_balance(chain)
            assert balance.chain == chain


@requires_private_key
class TestTransfer:
    """Integration tests for transfers (on testnet only)."""

    @pytest.mark.asyncio
    async def test_transfer_insufficient_funds(self, provider: EVMWalletProvider):
        """Test that insufficient funds raises error."""
        # Try to transfer more than we have
        params = TransferParams(
            from_chain=SupportedChain.SEPOLIA,
            to_address="0x1234567890123456789012345678901234567890",
            amount="999999999",  # Very large amount
        )

        with pytest.raises(EVMError) as exc:
            await execute_transfer(provider, params)

        # Should fail with insufficient funds or similar
        assert exc.value.code in ["INSUFFICIENT_FUNDS", "TRANSACTION_FAILED"]


@requires_private_key
class TestSwap:
    """Integration tests for swaps."""

    @pytest.mark.asyncio
    async def test_get_swap_quote(self, provider: EVMWalletProvider):
        """Test getting a swap quote (without executing)."""
        from elizaos_plugin_evm.actions.swap import get_lifi_quote

        # Get quote for ETH -> USDC on mainnet (read-only, no execution)
        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token="0x0000000000000000000000000000000000000000",  # ETH
            to_token="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  # USDC
            amount="1000000000000000000",  # 1 ETH in wei
        )

        try:
            quote = await get_lifi_quote(params, provider.address)
            assert quote.aggregator == "lifi"
            assert quote.to.startswith("0x")
            assert quote.data.startswith("0x")
        except EVMError as e:
            # Route not found is acceptable for this test
            if e.code != "ROUTE_NOT_FOUND":
                raise


@requires_private_key
class TestBridge:
    """Integration tests for bridges."""

    @pytest.mark.asyncio
    async def test_get_bridge_route(self, provider: EVMWalletProvider):
        """Test getting a bridge route (without executing)."""
        from elizaos_plugin_evm.actions.bridge import get_lifi_route

        # Get route for ETH mainnet -> base (read-only)
        params = BridgeParams(
            from_chain=SupportedChain.MAINNET,
            to_chain=SupportedChain.BASE,
            from_token="0x0000000000000000000000000000000000000000",  # ETH
            to_token="0x0000000000000000000000000000000000000000",  # ETH
            amount="1000000000000000000",  # 1 ETH in wei
        )

        try:
            route = await get_lifi_route(params, provider.address)
            assert "steps" in route
            assert len(route["steps"]) > 0
        except EVMError as e:
            # Route not found is acceptable for this test
            if e.code != "ROUTE_NOT_FOUND":
                raise


@requires_private_key
class TestTokenBalance:
    """Integration tests for token balance queries."""

    @pytest.mark.asyncio
    async def test_get_usdc_balance_mainnet(self, provider: EVMWalletProvider):
        """Test getting USDC balance on mainnet."""
        # USDC on mainnet
        usdc_address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

        token_balance = await provider.get_token_balance(
            SupportedChain.MAINNET,
            usdc_address,
        )

        assert token_balance.token.symbol == "USDC"
        assert token_balance.token.decimals == 6
        assert token_balance.balance >= 0

    @pytest.mark.asyncio
    async def test_get_weth_balance_base(self, provider: EVMWalletProvider):
        """Test getting WETH balance on Base."""
        # WETH on Base
        weth_address = "0x4200000000000000000000000000000000000006"

        token_balance = await provider.get_token_balance(
            SupportedChain.BASE,
            weth_address,
        )

        assert token_balance.token.symbol == "WETH"
        assert token_balance.token.decimals == 18


class TestAutoKeyGeneration:
    """Test automatic key generation."""

    def test_auto_generate_when_none(self):
        """Test that a key is generated when None is provided."""
        provider = EVMWalletProvider(None)

        assert provider.was_auto_generated is True
        assert provider.generated_key is not None
        assert provider.generated_key.private_key.startswith("0x")
        assert len(provider.generated_key.private_key) == 66  # 0x + 64 hex chars
        assert provider.generated_key.address.startswith("0x")
        assert len(provider.generated_key.address) == 42

    def test_auto_generate_when_empty(self):
        """Test that a key is generated when empty string is provided."""
        provider = EVMWalletProvider("")

        assert provider.was_auto_generated is True
        assert provider.generated_key is not None

    def test_no_auto_generate_when_provided(self, private_key: str):
        """Test that no key is generated when valid key is provided."""
        provider = EVMWalletProvider(private_key)

        assert provider.was_auto_generated is False
        assert provider.generated_key is None

    def test_generated_key_function(self):
        """Test the standalone generate_private_key function."""
        from elizaos_plugin_evm import generate_private_key

        generated = generate_private_key()

        assert generated.private_key.startswith("0x")
        assert len(generated.private_key) == 66
        assert generated.address.startswith("0x")
        assert len(generated.address) == 42

        # Verify the key works
        provider = EVMWalletProvider(generated.private_key)
        assert provider.address == generated.address


class TestErrorHandling:
    """Test error handling scenarios."""

    def test_invalid_private_key(self):
        """Test that invalid private key raises error."""
        with pytest.raises(EVMError) as exc:
            EVMWalletProvider("invalid_key")
        assert exc.value.code == "INVALID_PARAMS"

    @requires_private_key
    @pytest.mark.asyncio
    async def test_invalid_token_address(self, provider: EVMWalletProvider):
        """Test that invalid token address fails."""
        # Non-existent contract
        fake_address = "0x0000000000000000000000000000000000000001"

        with pytest.raises(EVMError):
            await provider.get_token_balance(
                SupportedChain.MAINNET,
                fake_address,
            )
