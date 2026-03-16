"""
Tests for all 7 EVM actions — parameter validation and action descriptors.

Execution paths are tested with mocked providers (no real RPC calls).
"""

from __future__ import annotations

from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_evm.actions.bridge import (
    bridge_action,
    evm_bridge_tokens_action,
    execute_bridge,
)
from elizaos_plugin_evm.actions.gov_execute import (
    execute_action,
    execute_governance,
)
from elizaos_plugin_evm.actions.gov_propose import (
    execute_propose,
    propose_action,
)
from elizaos_plugin_evm.actions.gov_queue import (
    execute_queue,
    queue_action,
)
from elizaos_plugin_evm.actions.gov_vote import (
    execute_vote,
    vote_action,
)
from elizaos_plugin_evm.actions.swap import (
    evm_swap_tokens_action,
    execute_swap,
    swap_action,
)
from elizaos_plugin_evm.actions.transfer import (
    evm_transfer_tokens_action,
    execute_transfer,
    transfer_action,
)
from elizaos_plugin_evm.error import EVMError, EVMErrorCode
from elizaos_plugin_evm.types import (
    BridgeParams,
    ExecuteParams,
    ProposeParams,
    QueueParams,
    SupportedChain,
    SwapParams,
    TokenInfo,
    TokenWithBalance,
    TransferParams,
    VoteParams,
)


VALID_ADDR = "0x1234567890123456789012345678901234567890"
VALID_ADDR_B = "0xabcdef1234567890123456789012345678901234"
VALID_TX_HASH = "0x" + "aa" * 32


# ─── Action Descriptor Tests ────────────────────────────────────────────────


class TestTransferActionDescriptor:
    def test_name(self) -> None:
        assert transfer_action["name"] == "TRANSFER_TOKEN"

    def test_ts_parity_name(self) -> None:
        assert evm_transfer_tokens_action["name"] == "EVM_TRANSFER_TOKENS"

    def test_has_description(self) -> None:
        assert len(transfer_action["description"]) > 0

    def test_has_similes(self) -> None:
        assert "send" in transfer_action["similes"]
        assert "transfer" in transfer_action["similes"]

    def test_has_examples(self) -> None:
        assert len(transfer_action["examples"]) >= 1

    def test_handler_is_callable(self) -> None:
        assert callable(transfer_action["handler"])
        assert transfer_action["handler"] is execute_transfer


class TestSwapActionDescriptor:
    def test_name(self) -> None:
        assert swap_action["name"] == "SWAP_TOKEN"

    def test_ts_parity_name(self) -> None:
        assert evm_swap_tokens_action["name"] == "EVM_SWAP_TOKENS"

    def test_has_description(self) -> None:
        assert len(swap_action["description"]) > 0

    def test_has_similes(self) -> None:
        assert "swap" in swap_action["similes"]
        assert "exchange" in swap_action["similes"]

    def test_handler_is_callable(self) -> None:
        assert callable(swap_action["handler"])
        assert swap_action["handler"] is execute_swap


class TestBridgeActionDescriptor:
    def test_name(self) -> None:
        assert bridge_action["name"] == "BRIDGE_TOKEN"

    def test_ts_parity_name(self) -> None:
        assert evm_bridge_tokens_action["name"] == "EVM_BRIDGE_TOKENS"

    def test_has_description(self) -> None:
        assert len(bridge_action["description"]) > 0

    def test_has_similes(self) -> None:
        assert "bridge" in bridge_action["similes"]

    def test_handler_is_callable(self) -> None:
        assert callable(bridge_action["handler"])


class TestVoteActionDescriptor:
    def test_name(self) -> None:
        assert vote_action["name"] == "VOTE"

    def test_has_similes(self) -> None:
        assert "GOVERNANCE_VOTE" in vote_action["similes"]

    def test_handler_is_callable(self) -> None:
        assert callable(vote_action["handler"])
        assert vote_action["handler"] is execute_vote


class TestProposeActionDescriptor:
    def test_name(self) -> None:
        assert propose_action["name"] == "PROPOSE"

    def test_handler_is_callable(self) -> None:
        assert callable(propose_action["handler"])
        assert propose_action["handler"] is execute_propose


class TestQueueActionDescriptor:
    def test_name(self) -> None:
        assert queue_action["name"] == "QUEUE"

    def test_handler_is_callable(self) -> None:
        assert callable(queue_action["handler"])
        assert queue_action["handler"] is execute_queue


class TestExecuteActionDescriptor:
    def test_name(self) -> None:
        assert execute_action["name"] == "EXECUTE"

    def test_handler_is_callable(self) -> None:
        assert callable(execute_action["handler"])
        assert execute_action["handler"] is execute_governance


# ─── Transfer Execution Tests (mocked) ──────────────────────────────────────


def _mock_provider(address: str = VALID_ADDR) -> MagicMock:
    provider = MagicMock()
    provider.address = address
    provider.send_transaction = AsyncMock(return_value=VALID_TX_HASH)
    provider.wait_for_transaction = AsyncMock(return_value=True)
    provider.send_token = AsyncMock(return_value=VALID_TX_HASH)
    provider.get_allowance = AsyncMock(return_value=0)
    provider.approve_token = AsyncMock(return_value=VALID_TX_HASH)
    return provider


class TestExecuteTransfer:
    @pytest.mark.asyncio
    async def test_native_transfer(self) -> None:
        provider = _mock_provider()
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_B,
            amount="1.5",
        )

        result = await execute_transfer(provider, params)

        assert result == VALID_TX_HASH
        provider.send_transaction.assert_called_once()
        call_kwargs = provider.send_transaction.call_args
        assert call_kwargs.kwargs["chain"] == SupportedChain.MAINNET
        assert call_kwargs.kwargs["to"] == VALID_ADDR_B
        # 1.5 ETH in wei = 1.5 * 10^18
        expected_wei = int(Decimal("1.5") * Decimal(10**18))
        assert call_kwargs.kwargs["value"] == expected_wei

    @pytest.mark.asyncio
    async def test_native_transfer_waits_for_confirmation(self) -> None:
        provider = _mock_provider()
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_B,
            amount="1.0",
        )

        await execute_transfer(provider, params)
        provider.wait_for_transaction.assert_called_once_with(
            SupportedChain.MAINNET, VALID_TX_HASH,
        )

    @pytest.mark.asyncio
    async def test_erc20_transfer(self) -> None:
        token_info = TokenInfo(
            address=VALID_ADDR,
            symbol="USDC",
            name="USD Coin",
            decimals=6,
            chain_id=1,
        )
        provider = _mock_provider()
        provider.get_token_balance = AsyncMock(
            return_value=TokenWithBalance(
                token=token_info,
                balance=1_000_000_000,  # 1000 USDC
                formatted_balance="1000.0",
            )
        )

        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_B,
            amount="100",
            token=VALID_ADDR,
        )

        result = await execute_transfer(provider, params)
        assert result == VALID_TX_HASH
        provider.send_token.assert_called_once()

    @pytest.mark.asyncio
    async def test_erc20_insufficient_balance_raises(self) -> None:
        token_info = TokenInfo(
            address=VALID_ADDR,
            symbol="USDC",
            name="USD Coin",
            decimals=6,
            chain_id=1,
        )
        provider = _mock_provider()
        provider.get_token_balance = AsyncMock(
            return_value=TokenWithBalance(
                token=token_info,
                balance=100,  # Only 0.0001 USDC
                formatted_balance="0.0001",
            )
        )

        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_B,
            amount="100",
            token=VALID_ADDR,
        )

        with pytest.raises(EVMError) as exc:
            await execute_transfer(provider, params)
        assert exc.value.code == EVMErrorCode.INSUFFICIENT_FUNDS

    @pytest.mark.asyncio
    async def test_native_token_address_treated_as_native(self) -> None:
        """If token == NATIVE_TOKEN_ADDRESS, use native transfer path."""
        provider = _mock_provider()
        native_addr = "0x0000000000000000000000000000000000000000"
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_B,
            amount="1.0",
            token=native_addr,
        )

        await execute_transfer(provider, params)
        # Should use send_transaction (native path), not send_token
        provider.send_transaction.assert_called_once()
        provider.send_token.assert_not_called()


# ─── Swap Execution Tests (mocked) ──────────────────────────────────────────


class TestExecuteSwap:
    @pytest.mark.asyncio
    async def test_swap_calls_lifi_and_sends_tx(self) -> None:
        from elizaos_plugin_evm.types import SwapQuote

        provider = _mock_provider()

        mock_quote = SwapQuote(
            aggregator="lifi",
            min_output_amount="100000000",
            to=VALID_ADDR_B,
            value=10**18,
            data="0xdeadbeef",
            gas_limit=250000,
        )

        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token="0x0000000000000000000000000000000000000000",
            to_token=VALID_ADDR_B,
            amount="1000000000000000000",
        )

        with patch(
            "elizaos_plugin_evm.actions.swap.get_lifi_quote",
            new_callable=AsyncMock,
            return_value=mock_quote,
        ):
            result = await execute_swap(provider, params)

        assert result == VALID_TX_HASH
        provider.send_transaction.assert_called_once()


# ─── Gov Vote Tests ──────────────────────────────────────────────────────────


class TestExecuteVote:
    @pytest.mark.asyncio
    async def test_invalid_support_value_raises(self) -> None:
        provider = _mock_provider()
        params = VoteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            proposal_id="1",
            support=5,  # invalid
        )

        with pytest.raises(EVMError) as exc:
            await execute_vote(provider, params)
        assert exc.value.code == EVMErrorCode.INVALID_PARAMS
        assert "Support must be 0" in exc.value.message

    @pytest.mark.asyncio
    async def test_valid_vote_for(self) -> None:
        provider = _mock_provider()
        params = VoteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            proposal_id="42",
            support=1,  # For
        )

        mock_w3 = MagicMock()
        mock_w3.keccak.return_value = b"\x56\x78\x13\x88" + b"\x00" * 28
        mock_w3.codec.encode.return_value = b"\x00" * 64

        with patch("web3.Web3", return_value=mock_w3):
            result = await execute_vote(provider, params)

        assert result == VALID_TX_HASH
        provider.send_transaction.assert_called_once()

    @pytest.mark.asyncio
    async def test_valid_vote_against(self) -> None:
        provider = _mock_provider()
        params = VoteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            proposal_id="1",
            support=0,  # Against
        )

        mock_w3 = MagicMock()
        mock_w3.keccak.return_value = b"\x56\x78\x13\x88" + b"\x00" * 28
        mock_w3.codec.encode.return_value = b"\x00" * 64

        with patch("web3.Web3", return_value=mock_w3):
            result = await execute_vote(provider, params)

        assert result == VALID_TX_HASH

    @pytest.mark.asyncio
    async def test_valid_vote_abstain(self) -> None:
        provider = _mock_provider()
        params = VoteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            proposal_id="1",
            support=2,  # Abstain
        )

        mock_w3 = MagicMock()
        mock_w3.keccak.return_value = b"\x56\x78\x13\x88" + b"\x00" * 28
        mock_w3.codec.encode.return_value = b"\x00" * 64

        with patch("web3.Web3", return_value=mock_w3):
            result = await execute_vote(provider, params)

        assert result == VALID_TX_HASH


# ─── Gov Propose Tests ───────────────────────────────────────────────────────


class TestExecutePropose:
    @pytest.mark.asyncio
    async def test_empty_targets_raises(self) -> None:
        provider = _mock_provider()
        params = ProposeParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[],
            values=[],
            calldatas=[],
            description="Test proposal",
        )

        with pytest.raises(EVMError) as exc:
            await execute_propose(provider, params)
        assert exc.value.code == EVMErrorCode.INVALID_PARAMS
        assert "Targets array cannot be empty" in exc.value.message

    @pytest.mark.asyncio
    async def test_mismatched_targets_values_raises(self) -> None:
        provider = _mock_provider()
        params = ProposeParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[VALID_ADDR],
            values=[0, 1],  # Length mismatch
            calldatas=["0x"],
            description="Test",
        )

        with pytest.raises(EVMError) as exc:
            await execute_propose(provider, params)
        assert "same length" in exc.value.message

    @pytest.mark.asyncio
    async def test_mismatched_targets_calldatas_raises(self) -> None:
        provider = _mock_provider()
        params = ProposeParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[VALID_ADDR],
            values=[0],
            calldatas=["0x", "0x"],  # Length mismatch
            description="Test",
        )

        with pytest.raises(EVMError) as exc:
            await execute_propose(provider, params)
        assert "same length" in exc.value.message

    @pytest.mark.asyncio
    async def test_empty_description_raises(self) -> None:
        provider = _mock_provider()
        params = ProposeParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[VALID_ADDR],
            values=[0],
            calldatas=["0x"],
            description="",
        )

        with pytest.raises(EVMError) as exc:
            await execute_propose(provider, params)
        assert "Description cannot be empty" in exc.value.message

    @pytest.mark.asyncio
    async def test_valid_proposal(self) -> None:
        provider = _mock_provider()
        params = ProposeParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[VALID_ADDR_B],
            values=[0],
            calldatas=["0xdeadbeef"],
            description="Transfer tokens to treasury",
        )

        mock_w3 = MagicMock()
        mock_w3.keccak.return_value = b"\x7d\x5e\x81\xe2" + b"\x00" * 28
        mock_w3.codec.encode.return_value = b"\x00" * 128

        with patch("web3.Web3", return_value=mock_w3):
            result = await execute_propose(provider, params)

        assert result == VALID_TX_HASH


# ─── Gov Queue Tests ─────────────────────────────────────────────────────────


class TestExecuteQueue:
    @pytest.mark.asyncio
    async def test_empty_targets_raises(self) -> None:
        provider = _mock_provider()
        params = QueueParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[],
            values=[],
            calldatas=[],
            description_hash="0x" + "ab" * 32,
        )

        with pytest.raises(EVMError) as exc:
            await execute_queue(provider, params)
        assert "Targets array cannot be empty" in exc.value.message

    @pytest.mark.asyncio
    async def test_valid_queue(self) -> None:
        provider = _mock_provider()
        params = QueueParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[VALID_ADDR_B],
            values=[0],
            calldatas=["0x"],
            description_hash="0x" + "ab" * 32,
        )

        mock_w3 = MagicMock()
        mock_w3.keccak.return_value = b"\x16\x0c\xbe\xd7" + b"\x00" * 28
        mock_w3.codec.encode.return_value = b"\x00" * 128

        with patch("web3.Web3", return_value=mock_w3):
            result = await execute_queue(provider, params)

        assert result == VALID_TX_HASH


# ─── Gov Execute Tests ───────────────────────────────────────────────────────


class TestExecuteGovernance:
    @pytest.mark.asyncio
    async def test_empty_targets_raises(self) -> None:
        provider = _mock_provider()
        params = ExecuteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[],
            values=[],
            calldatas=[],
            description_hash="0x" + "cd" * 32,
        )

        with pytest.raises(EVMError) as exc:
            await execute_governance(provider, params)
        assert "Targets array cannot be empty" in exc.value.message

    @pytest.mark.asyncio
    async def test_valid_execute(self) -> None:
        provider = _mock_provider()
        params = ExecuteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR,
            targets=[VALID_ADDR_B],
            values=[0],
            calldatas=["0x"],
            description_hash="0x" + "cd" * 32,
        )

        mock_w3 = MagicMock()
        mock_w3.keccak.return_value = b"\x26\x56\x22\x7d" + b"\x00" * 28
        mock_w3.codec.encode.return_value = b"\x00" * 128

        with patch("web3.Web3", return_value=mock_w3):
            result = await execute_governance(provider, params)

        assert result == VALID_TX_HASH
