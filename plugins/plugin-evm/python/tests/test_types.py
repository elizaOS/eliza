"""
Tests for type validation.
"""

import pytest
from pydantic import ValidationError

from elizaos_plugin_evm.types import (
    BridgeParams,
    SupportedChain,
    SwapParams,
    TransferParams,
)


class TestTransferParams:
    """Test TransferParams validation."""

    def test_valid_transfer(self):
        """Test valid transfer params."""
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address="0x1234567890123456789012345678901234567890",
            amount="1.5",
        )
        assert params.from_chain == SupportedChain.MAINNET
        assert params.amount == "1.5"

    def test_invalid_address(self):
        """Test invalid address fails."""
        with pytest.raises(ValidationError) as exc:
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address="0xinvalid",
                amount="1.0",
            )
        assert "to_address" in str(exc.value)

    def test_zero_amount_fails(self):
        """Test zero amount fails."""
        with pytest.raises(ValidationError) as exc:
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address="0x1234567890123456789012345678901234567890",
                amount="0",
            )
        assert "Amount must be positive" in str(exc.value)

    def test_zero_address_fails(self):
        """Test transfer to zero address fails."""
        with pytest.raises(ValidationError) as exc:
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address="0x0000000000000000000000000000000000000000",
                amount="1.0",
            )
        assert "cannot be zero" in str(exc.value)


class TestSwapParams:
    """Test SwapParams validation."""

    def test_valid_swap(self):
        """Test valid swap params."""
        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token="0x1234567890123456789012345678901234567890",
            to_token="0xabcdef1234567890123456789012345678901234",
            amount="100",
        )
        assert params.chain == SupportedChain.MAINNET
        assert params.slippage is None

    def test_same_token_fails(self):
        """Test swapping to same token fails."""
        with pytest.raises(ValidationError) as exc:
            SwapParams(
                chain=SupportedChain.MAINNET,
                from_token="0x1234567890123456789012345678901234567890",
                to_token="0x1234567890123456789012345678901234567890",
                amount="100",
            )
        assert "must be different" in str(exc.value)

    def test_slippage_bounds(self):
        """Test slippage validation."""
        # Valid slippage
        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token="0x1234567890123456789012345678901234567890",
            to_token="0xabcdef1234567890123456789012345678901234",
            amount="100",
            slippage=0.05,
        )
        assert params.slippage == 0.05

        # Invalid slippage > 1
        with pytest.raises(ValidationError):
            SwapParams(
                chain=SupportedChain.MAINNET,
                from_token="0x1234567890123456789012345678901234567890",
                to_token="0xabcdef1234567890123456789012345678901234",
                amount="100",
                slippage=1.5,
            )


class TestBridgeParams:
    """Test BridgeParams validation."""

    def test_valid_bridge(self):
        """Test valid bridge params."""
        params = BridgeParams(
            from_chain=SupportedChain.MAINNET,
            to_chain=SupportedChain.BASE,
            from_token="0x1234567890123456789012345678901234567890",
            to_token="0xabcdef1234567890123456789012345678901234",
            amount="1.0",
        )
        assert params.from_chain == SupportedChain.MAINNET
        assert params.to_chain == SupportedChain.BASE

    def test_same_chain_fails(self):
        """Test bridging to same chain fails."""
        with pytest.raises(ValidationError) as exc:
            BridgeParams(
                from_chain=SupportedChain.MAINNET,
                to_chain=SupportedChain.MAINNET,
                from_token="0x1234567890123456789012345678901234567890",
                to_token="0xabcdef1234567890123456789012345678901234",
                amount="1.0",
            )
        assert "must be different" in str(exc.value)


class TestSupportedChain:
    """Test SupportedChain enum."""

    def test_chain_properties(self):
        """Test chain ID and native symbol properties."""
        assert SupportedChain.MAINNET.chain_id == 1
        assert SupportedChain.MAINNET.native_symbol == "ETH"
        assert not SupportedChain.MAINNET.is_testnet

        assert SupportedChain.SEPOLIA.chain_id == 11155111
        assert SupportedChain.SEPOLIA.native_symbol == "ETH"
        assert SupportedChain.SEPOLIA.is_testnet

        assert SupportedChain.POLYGON.chain_id == 137
        assert SupportedChain.POLYGON.native_symbol == "MATIC"

    def test_default_rpc(self):
        """Test default RPC URLs are set."""
        for chain in SupportedChain:
            assert chain.default_rpc.startswith("https://")
