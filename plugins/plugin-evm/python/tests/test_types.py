"""
Comprehensive tests for EVM plugin type definitions, validation, and chain configs.
"""

import pytest
from pydantic import ValidationError

from elizaos_plugin_evm.types import (
    BridgeParams,
    BridgeStatus,
    BridgeStatusType,
    ExecuteParams,
    ProposeParams,
    QueueParams,
    SupportedChain,
    SwapParams,
    SwapQuote,
    TokenInfo,
    TokenWithBalance,
    Transaction,
    TransferParams,
    VoteParams,
    VoteType,
    WalletBalance,
)


# ─── Valid address / hash constants ──────────────────────────────────────────

VALID_ADDR_A = "0x1234567890123456789012345678901234567890"
VALID_ADDR_B = "0xabcdef1234567890123456789012345678901234"
VALID_ADDR_C = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF"
ZERO_ADDR = "0x0000000000000000000000000000000000000000"
VALID_TX_HASH = "0x" + "ab" * 32
VALID_HEX_DATA = "0xdeadbeef"


# ─── SupportedChain ─────────────────────────────────────────────────────────


class TestSupportedChain:
    """Test SupportedChain enum properties for all 14 chains."""

    EXPECTED_CHAIN_IDS: dict[SupportedChain, int] = {
        SupportedChain.MAINNET: 1,
        SupportedChain.SEPOLIA: 11155111,
        SupportedChain.BASE: 8453,
        SupportedChain.BASE_SEPOLIA: 84532,
        SupportedChain.ARBITRUM: 42161,
        SupportedChain.OPTIMISM: 10,
        SupportedChain.POLYGON: 137,
        SupportedChain.AVALANCHE: 43114,
        SupportedChain.BSC: 56,
        SupportedChain.GNOSIS: 100,
        SupportedChain.FANTOM: 250,
        SupportedChain.LINEA: 59144,
        SupportedChain.SCROLL: 534352,
        SupportedChain.ZKSYNC: 324,
    }

    EXPECTED_SYMBOLS: dict[SupportedChain, str] = {
        SupportedChain.MAINNET: "ETH",
        SupportedChain.SEPOLIA: "ETH",
        SupportedChain.BASE: "ETH",
        SupportedChain.BASE_SEPOLIA: "ETH",
        SupportedChain.ARBITRUM: "ETH",
        SupportedChain.OPTIMISM: "ETH",
        SupportedChain.POLYGON: "MATIC",
        SupportedChain.AVALANCHE: "AVAX",
        SupportedChain.BSC: "BNB",
        SupportedChain.GNOSIS: "xDAI",
        SupportedChain.FANTOM: "FTM",
        SupportedChain.LINEA: "ETH",
        SupportedChain.SCROLL: "ETH",
        SupportedChain.ZKSYNC: "ETH",
    }

    def test_all_chain_ids(self) -> None:
        """Every chain returns its expected chain id."""
        for chain, expected_id in self.EXPECTED_CHAIN_IDS.items():
            assert chain.chain_id == expected_id, f"{chain.value} chain_id mismatch"

    def test_all_native_symbols(self) -> None:
        """Every chain returns its expected native token symbol."""
        for chain, expected_sym in self.EXPECTED_SYMBOLS.items():
            assert chain.native_symbol == expected_sym, f"{chain.value} symbol mismatch"

    def test_all_default_rpcs_are_https(self) -> None:
        """Every chain has an https default RPC URL."""
        for chain in SupportedChain:
            assert chain.default_rpc.startswith("https://"), (
                f"{chain.value} default_rpc should start with https://"
            )

    def test_testnet_identification(self) -> None:
        """Only Sepolia and BaseSepolia are testnets."""
        testnets = {c for c in SupportedChain if c.is_testnet}
        assert testnets == {SupportedChain.SEPOLIA, SupportedChain.BASE_SEPOLIA}

    def test_mainnet_chains_are_not_testnet(self) -> None:
        """Non-testnet chains report is_testnet=False."""
        for chain in SupportedChain:
            if chain not in {SupportedChain.SEPOLIA, SupportedChain.BASE_SEPOLIA}:
                assert chain.is_testnet is False

    def test_enum_count(self) -> None:
        """We support exactly 14 chains."""
        assert len(SupportedChain) == 14

    def test_enum_values_are_strings(self) -> None:
        """Each enum member is a str."""
        for chain in SupportedChain:
            assert isinstance(chain.value, str)

    def test_enum_from_value(self) -> None:
        """Create chain from its string value."""
        assert SupportedChain("mainnet") is SupportedChain.MAINNET
        assert SupportedChain("baseSepolia") is SupportedChain.BASE_SEPOLIA

    def test_invalid_chain_value_raises(self) -> None:
        """Unknown chain string raises ValueError."""
        with pytest.raises(ValueError):
            SupportedChain("nonexistent_chain")


# ─── Address / Hash Type Aliases ─────────────────────────────────────────────


class TestAddressValidation:
    """Pydantic Address type validates the 0x + 40-hex pattern."""

    def test_valid_lowercase_address(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_A,
            amount="1.0",
        )
        assert params.to_address == VALID_ADDR_A

    def test_valid_mixed_case_address(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_C,
            amount="1.0",
        )
        assert params.to_address == VALID_ADDR_C

    def test_short_address_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address="0x1234",
                amount="1.0",
            )

    def test_missing_prefix_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address="1234567890123456789012345678901234567890",
                amount="1.0",
            )

    def test_non_hex_address_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address="0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
                amount="1.0",
            )


# ─── Transaction Model ──────────────────────────────────────────────────────


class TestTransaction:
    """Test the Transaction Pydantic model."""

    def test_construction_with_aliases(self) -> None:
        tx = Transaction(
            hash=VALID_TX_HASH,
            **{"from": VALID_ADDR_A, "to": VALID_ADDR_B},
            value=1000,
        )
        assert tx.hash == VALID_TX_HASH
        assert tx.from_address == VALID_ADDR_A
        assert tx.to_address == VALID_ADDR_B
        assert tx.value == 1000
        assert tx.data is None
        assert tx.chain_id is None

    def test_optional_fields(self) -> None:
        tx = Transaction(
            hash=VALID_TX_HASH,
            **{"from": VALID_ADDR_A, "to": VALID_ADDR_B},
            value=0,
            data=VALID_HEX_DATA,
            chain_id=1,
        )
        assert tx.data == VALID_HEX_DATA
        assert tx.chain_id == 1

    def test_frozen(self) -> None:
        tx = Transaction(
            hash=VALID_TX_HASH,
            **{"from": VALID_ADDR_A, "to": VALID_ADDR_B},
            value=0,
        )
        with pytest.raises(ValidationError):
            tx.value = 999  # type: ignore[misc]


# ─── TokenInfo Model ────────────────────────────────────────────────────────


class TestTokenInfo:
    def test_standard_erc20(self) -> None:
        token = TokenInfo(
            address=VALID_ADDR_A,
            symbol="USDC",
            name="USD Coin",
            decimals=6,
            chain_id=1,
        )
        assert token.symbol == "USDC"
        assert token.decimals == 6
        assert token.logo_uri is None

    def test_18_decimals(self) -> None:
        token = TokenInfo(
            address=VALID_ADDR_A, symbol="WETH", name="Wrapped Ether",
            decimals=18, chain_id=1,
        )
        assert token.decimals == 18

    def test_zero_decimals(self) -> None:
        token = TokenInfo(
            address=VALID_ADDR_A, symbol="NFT", name="NFT Token",
            decimals=0, chain_id=1,
        )
        assert token.decimals == 0

    def test_decimals_above_18_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TokenInfo(
                address=VALID_ADDR_A, symbol="BAD", name="Bad",
                decimals=19, chain_id=1,
            )

    def test_negative_decimals_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TokenInfo(
                address=VALID_ADDR_A, symbol="BAD", name="Bad",
                decimals=-1, chain_id=1,
            )

    def test_with_logo_uri(self) -> None:
        token = TokenInfo(
            address=VALID_ADDR_A, symbol="TKN", name="Token",
            decimals=18, chain_id=1,
            logo_uri="https://example.com/logo.png",
        )
        assert token.logo_uri == "https://example.com/logo.png"


# ─── WalletBalance & TokenWithBalance ────────────────────────────────────────


class TestWalletBalance:
    def test_basic_construction(self) -> None:
        wb = WalletBalance(
            chain=SupportedChain.MAINNET,
            address=VALID_ADDR_A,
            native_balance="1.5",
        )
        assert wb.chain == SupportedChain.MAINNET
        assert wb.native_balance == "1.5"
        assert wb.tokens == []

    def test_with_tokens(self) -> None:
        token_info = TokenInfo(
            address=VALID_ADDR_B, symbol="USDC", name="USD Coin",
            decimals=6, chain_id=1,
        )
        twb = TokenWithBalance(
            token=token_info, balance=1000000,
            formatted_balance="1.0",
        )
        wb = WalletBalance(
            chain=SupportedChain.MAINNET,
            address=VALID_ADDR_A,
            native_balance="0.5",
            tokens=[twb],
        )
        assert len(wb.tokens) == 1
        assert wb.tokens[0].token.symbol == "USDC"


class TestTokenWithBalance:
    def test_basic_construction(self) -> None:
        info = TokenInfo(
            address=VALID_ADDR_A, symbol="DAI", name="Dai",
            decimals=18, chain_id=1,
        )
        twb = TokenWithBalance(
            token=info, balance=10**18,
            formatted_balance="1.0",
        )
        assert twb.balance == 10**18
        assert twb.formatted_balance == "1.0"
        assert twb.price_usd is None
        assert twb.value_usd is None

    def test_with_price_data(self) -> None:
        info = TokenInfo(
            address=VALID_ADDR_A, symbol="ETH", name="Ether",
            decimals=18, chain_id=1,
        )
        twb = TokenWithBalance(
            token=info, balance=10**18,
            formatted_balance="1.0",
            price_usd="2500.00",
            value_usd="2500.00",
        )
        assert twb.price_usd == "2500.00"
        assert twb.value_usd == "2500.00"


# ─── TransferParams ─────────────────────────────────────────────────────────


class TestTransferParams:
    def test_valid_native_transfer(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_A,
            amount="1.5",
        )
        assert params.from_chain == SupportedChain.MAINNET
        assert params.amount == "1.5"
        assert params.token is None
        assert params.data is None

    def test_valid_erc20_transfer(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.BASE,
            to_address=VALID_ADDR_A,
            amount="100",
            token=VALID_ADDR_B,
        )
        assert params.token == VALID_ADDR_B

    def test_with_data_field(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_A,
            amount="1.0",
            data=VALID_HEX_DATA,
        )
        assert params.data == VALID_HEX_DATA

    def test_invalid_address_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc:
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address="0xinvalid",
                amount="1.0",
            )
        assert "to_address" in str(exc.value)

    def test_zero_amount_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc:
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address=VALID_ADDR_A,
                amount="0",
            )
        assert "Amount must be positive" in str(exc.value)

    def test_negative_amount_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address=VALID_ADDR_A,
                amount="-1.0",
            )

    def test_zero_address_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc:
            TransferParams(
                from_chain=SupportedChain.MAINNET,
                to_address=ZERO_ADDR,
                amount="1.0",
            )
        assert "cannot be zero" in str(exc.value)

    def test_decimal_amount(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_A,
            amount="0.000000001",
        )
        assert params.amount == "0.000000001"

    def test_large_amount(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_A,
            amount="999999999999999",
        )
        assert params.amount == "999999999999999"

    def test_frozen(self) -> None:
        params = TransferParams(
            from_chain=SupportedChain.MAINNET,
            to_address=VALID_ADDR_A,
            amount="1.0",
        )
        with pytest.raises(ValidationError):
            params.amount = "2.0"  # type: ignore[misc]

    def test_all_chains_accepted(self) -> None:
        """TransferParams works with every supported chain."""
        for chain in SupportedChain:
            params = TransferParams(
                from_chain=chain,
                to_address=VALID_ADDR_A,
                amount="1.0",
            )
            assert params.from_chain == chain


# ─── SwapParams ──────────────────────────────────────────────────────────────


class TestSwapParams:
    def test_valid_swap(self) -> None:
        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token=VALID_ADDR_A,
            to_token=VALID_ADDR_B,
            amount="100",
        )
        assert params.chain == SupportedChain.MAINNET
        assert params.slippage is None

    def test_with_slippage(self) -> None:
        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token=VALID_ADDR_A,
            to_token=VALID_ADDR_B,
            amount="100",
            slippage=0.05,
        )
        assert params.slippage == 0.05

    def test_slippage_zero(self) -> None:
        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token=VALID_ADDR_A,
            to_token=VALID_ADDR_B,
            amount="100",
            slippage=0.0,
        )
        assert params.slippage == 0.0

    def test_slippage_one(self) -> None:
        """Max slippage = 1 (100%)."""
        params = SwapParams(
            chain=SupportedChain.MAINNET,
            from_token=VALID_ADDR_A,
            to_token=VALID_ADDR_B,
            amount="100",
            slippage=1.0,
        )
        assert params.slippage == 1.0

    def test_slippage_above_one_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SwapParams(
                chain=SupportedChain.MAINNET,
                from_token=VALID_ADDR_A,
                to_token=VALID_ADDR_B,
                amount="100",
                slippage=1.5,
            )

    def test_negative_slippage_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SwapParams(
                chain=SupportedChain.MAINNET,
                from_token=VALID_ADDR_A,
                to_token=VALID_ADDR_B,
                amount="100",
                slippage=-0.01,
            )

    def test_same_token_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc:
            SwapParams(
                chain=SupportedChain.MAINNET,
                from_token=VALID_ADDR_A,
                to_token=VALID_ADDR_A,
                amount="100",
            )
        assert "must be different" in str(exc.value)

    def test_same_token_case_insensitive(self) -> None:
        """Same address in different cases should still be rejected."""
        with pytest.raises(ValidationError):
            SwapParams(
                chain=SupportedChain.MAINNET,
                from_token="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                to_token="0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                amount="100",
            )

    def test_zero_amount_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SwapParams(
                chain=SupportedChain.MAINNET,
                from_token=VALID_ADDR_A,
                to_token=VALID_ADDR_B,
                amount="0",
            )


# ─── SwapQuote ───────────────────────────────────────────────────────────────


class TestSwapQuote:
    def test_construction(self) -> None:
        quote = SwapQuote(
            aggregator="lifi",
            min_output_amount="100000000",
            to=VALID_ADDR_A,
            value=10**18,
            data=VALID_HEX_DATA,
        )
        assert quote.aggregator == "lifi"
        assert quote.gas_limit is None

    def test_with_gas_limit(self) -> None:
        quote = SwapQuote(
            aggregator="lifi",
            min_output_amount="100000000",
            to=VALID_ADDR_A,
            value=0,
            data="0x",
            gas_limit=250000,
        )
        assert quote.gas_limit == 250000


# ─── BridgeParams ────────────────────────────────────────────────────────────


class TestBridgeParams:
    def test_valid_bridge(self) -> None:
        params = BridgeParams(
            from_chain=SupportedChain.MAINNET,
            to_chain=SupportedChain.BASE,
            from_token=VALID_ADDR_A,
            to_token=VALID_ADDR_B,
            amount="1.0",
        )
        assert params.from_chain == SupportedChain.MAINNET
        assert params.to_chain == SupportedChain.BASE
        assert params.to_address is None

    def test_with_recipient(self) -> None:
        params = BridgeParams(
            from_chain=SupportedChain.MAINNET,
            to_chain=SupportedChain.BASE,
            from_token=VALID_ADDR_A,
            to_token=VALID_ADDR_B,
            amount="1.0",
            to_address=VALID_ADDR_C,
        )
        assert params.to_address == VALID_ADDR_C

    def test_same_chain_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc:
            BridgeParams(
                from_chain=SupportedChain.MAINNET,
                to_chain=SupportedChain.MAINNET,
                from_token=VALID_ADDR_A,
                to_token=VALID_ADDR_B,
                amount="1.0",
            )
        assert "must be different" in str(exc.value)

    def test_zero_amount_rejected(self) -> None:
        with pytest.raises(ValidationError):
            BridgeParams(
                from_chain=SupportedChain.MAINNET,
                to_chain=SupportedChain.BASE,
                from_token=VALID_ADDR_A,
                to_token=VALID_ADDR_B,
                amount="0",
            )

    def test_various_chain_pairs(self) -> None:
        """Multiple cross-chain combos work."""
        combos = [
            (SupportedChain.MAINNET, SupportedChain.ARBITRUM),
            (SupportedChain.BASE, SupportedChain.OPTIMISM),
            (SupportedChain.POLYGON, SupportedChain.BSC),
        ]
        for src, dst in combos:
            params = BridgeParams(
                from_chain=src, to_chain=dst,
                from_token=VALID_ADDR_A, to_token=VALID_ADDR_B,
                amount="1.0",
            )
            assert params.from_chain == src
            assert params.to_chain == dst


# ─── BridgeStatus ────────────────────────────────────────────────────────────


class TestBridgeStatus:
    def test_pending(self) -> None:
        status = BridgeStatus(
            status=BridgeStatusType.PENDING,
            source_tx_hash=VALID_TX_HASH,
        )
        assert status.status == BridgeStatusType.PENDING
        assert status.substatus is None
        assert status.dest_tx_hash is None

    def test_done(self) -> None:
        dest_hash = "0x" + "cd" * 32
        status = BridgeStatus(
            status=BridgeStatusType.DONE,
            substatus="COMPLETED",
            source_tx_hash=VALID_TX_HASH,
            dest_tx_hash=dest_hash,
        )
        assert status.status == BridgeStatusType.DONE
        assert status.dest_tx_hash == dest_hash

    def test_failed(self) -> None:
        status = BridgeStatus(
            status=BridgeStatusType.FAILED,
            substatus="SLIPPAGE_TOO_HIGH",
            source_tx_hash=VALID_TX_HASH,
        )
        assert status.status == BridgeStatusType.FAILED

    def test_enum_values(self) -> None:
        assert BridgeStatusType.PENDING.value == "PENDING"
        assert BridgeStatusType.DONE.value == "DONE"
        assert BridgeStatusType.FAILED.value == "FAILED"


# ─── VoteType ────────────────────────────────────────────────────────────────


class TestVoteType:
    def test_values(self) -> None:
        assert VoteType.AGAINST.value == 0
        assert VoteType.FOR.value == 1
        assert VoteType.ABSTAIN.value == 2

    def test_int_enum(self) -> None:
        assert VoteType.AGAINST == 0
        assert VoteType.FOR == 1
        assert VoteType.ABSTAIN == 2


# ─── VoteParams ──────────────────────────────────────────────────────────────


class TestVoteParams:
    def test_construction(self) -> None:
        params = VoteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR_A,
            proposal_id="1",
            support=1,
        )
        assert params.chain == SupportedChain.MAINNET
        assert params.governor == VALID_ADDR_A
        assert params.proposal_id == "1"
        assert params.support == 1

    def test_all_vote_types(self) -> None:
        for support_val in [0, 1, 2]:
            params = VoteParams(
                chain=SupportedChain.MAINNET,
                governor=VALID_ADDR_A,
                proposal_id="42",
                support=support_val,
            )
            assert params.support == support_val


# ─── ProposeParams ───────────────────────────────────────────────────────────


class TestProposeParams:
    def test_construction(self) -> None:
        params = ProposeParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR_A,
            targets=[VALID_ADDR_B],
            values=[0],
            calldatas=["0x"],
            description="Transfer funds",
        )
        assert len(params.targets) == 1
        assert params.description == "Transfer funds"

    def test_multiple_actions(self) -> None:
        params = ProposeParams(
            chain=SupportedChain.BASE,
            governor=VALID_ADDR_A,
            targets=[VALID_ADDR_B, VALID_ADDR_C],
            values=[100, 200],
            calldatas=["0xaa", "0xbb"],
            description="Multi-action proposal",
        )
        assert len(params.targets) == 2
        assert len(params.values) == 2
        assert len(params.calldatas) == 2


# ─── QueueParams ─────────────────────────────────────────────────────────────


class TestQueueParams:
    def test_construction(self) -> None:
        params = QueueParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR_A,
            targets=[VALID_ADDR_B],
            values=[0],
            calldatas=["0x"],
            description_hash="0x" + "ab" * 32,
        )
        assert params.description_hash == "0x" + "ab" * 32


# ─── ExecuteParams ───────────────────────────────────────────────────────────


class TestExecuteParams:
    def test_construction(self) -> None:
        params = ExecuteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR_A,
            targets=[VALID_ADDR_B],
            values=[0],
            calldatas=["0x"],
            description_hash="0x" + "cd" * 32,
        )
        assert params.description_hash == "0x" + "cd" * 32

    def test_frozen(self) -> None:
        params = ExecuteParams(
            chain=SupportedChain.MAINNET,
            governor=VALID_ADDR_A,
            targets=[VALID_ADDR_B],
            values=[0],
            calldatas=["0x"],
            description_hash="0x" + "cd" * 32,
        )
        with pytest.raises(ValidationError):
            params.description_hash = "0x00"  # type: ignore[misc]
