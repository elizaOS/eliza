"""
Tests for EVM plugin constants and configuration values.
"""

from elizaos_plugin_evm.constants import (
    BEBOP_API_URL,
    BRIDGE_POLL_INTERVAL_SECS,
    CACHE_REFRESH_INTERVAL_SECS,
    DEFAULT_CHAINS,
    DEFAULT_DECIMALS,
    DEFAULT_SLIPPAGE_PERCENT,
    ERC20_ABI,
    EVM_SERVICE_NAME,
    EVM_WALLET_DATA_CACHE_KEY,
    GAS_BUFFER_MULTIPLIER,
    GAS_PRICE_MULTIPLIER,
    LIFI_API_URL,
    MAX_BRIDGE_POLL_ATTEMPTS,
    MAX_PRICE_IMPACT,
    MAX_SLIPPAGE_PERCENT,
    NATIVE_TOKEN_ADDRESS,
    TX_CONFIRMATION_TIMEOUT_SECS,
)


class TestCacheConstants:
    def test_cache_key(self) -> None:
        assert EVM_WALLET_DATA_CACHE_KEY == "evm/wallet/data"

    def test_service_name(self) -> None:
        assert EVM_SERVICE_NAME == "evmService"

    def test_cache_refresh_interval(self) -> None:
        assert CACHE_REFRESH_INTERVAL_SECS == 60
        assert isinstance(CACHE_REFRESH_INTERVAL_SECS, int)


class TestGasConstants:
    def test_gas_buffer_multiplier(self) -> None:
        assert GAS_BUFFER_MULTIPLIER == 1.2
        assert GAS_BUFFER_MULTIPLIER > 1.0

    def test_gas_price_multiplier(self) -> None:
        assert GAS_PRICE_MULTIPLIER == 1.1
        assert GAS_PRICE_MULTIPLIER > 1.0


class TestSlippageConstants:
    def test_max_slippage(self) -> None:
        assert MAX_SLIPPAGE_PERCENT == 0.05
        assert 0 < MAX_SLIPPAGE_PERCENT < 1.0

    def test_default_slippage(self) -> None:
        assert DEFAULT_SLIPPAGE_PERCENT == 0.01
        assert DEFAULT_SLIPPAGE_PERCENT < MAX_SLIPPAGE_PERCENT

    def test_max_price_impact(self) -> None:
        assert MAX_PRICE_IMPACT == 0.4
        assert 0 < MAX_PRICE_IMPACT < 1.0


class TestTimeoutConstants:
    def test_tx_confirmation_timeout(self) -> None:
        assert TX_CONFIRMATION_TIMEOUT_SECS == 60
        assert TX_CONFIRMATION_TIMEOUT_SECS > 0

    def test_bridge_poll_interval(self) -> None:
        assert BRIDGE_POLL_INTERVAL_SECS == 5
        assert BRIDGE_POLL_INTERVAL_SECS > 0

    def test_max_bridge_poll_attempts(self) -> None:
        assert MAX_BRIDGE_POLL_ATTEMPTS == 60
        assert MAX_BRIDGE_POLL_ATTEMPTS > 0


class TestTokenConstants:
    def test_native_token_address(self) -> None:
        assert NATIVE_TOKEN_ADDRESS == "0x0000000000000000000000000000000000000000"
        assert NATIVE_TOKEN_ADDRESS.startswith("0x")
        assert len(NATIVE_TOKEN_ADDRESS) == 42

    def test_default_decimals(self) -> None:
        assert DEFAULT_DECIMALS == 18


class TestApiUrls:
    def test_lifi_api_url(self) -> None:
        assert LIFI_API_URL == "https://li.quest/v1"
        assert LIFI_API_URL.startswith("https://")

    def test_bebop_api_url(self) -> None:
        assert BEBOP_API_URL == "https://api.bebop.xyz/router"
        assert BEBOP_API_URL.startswith("https://")


class TestDefaultChains:
    def test_default_chains_list(self) -> None:
        assert DEFAULT_CHAINS == ["mainnet", "base"]
        assert len(DEFAULT_CHAINS) == 2

    def test_default_chains_are_valid(self) -> None:
        from elizaos_plugin_evm.types import SupportedChain

        for chain_name in DEFAULT_CHAINS:
            # Should not raise
            SupportedChain(chain_name)


class TestERC20ABI:
    def test_abi_is_list(self) -> None:
        assert isinstance(ERC20_ABI, list)

    def test_has_expected_functions(self) -> None:
        fn_names = {entry["name"] for entry in ERC20_ABI}
        assert "balanceOf" in fn_names
        assert "decimals" in fn_names
        assert "symbol" in fn_names
        assert "transfer" in fn_names
        assert "approve" in fn_names
        assert "allowance" in fn_names

    def test_abi_has_six_entries(self) -> None:
        assert len(ERC20_ABI) == 6

    def test_balance_of_structure(self) -> None:
        balance_of = next(e for e in ERC20_ABI if e["name"] == "balanceOf")
        assert balance_of["constant"] is True
        assert balance_of["type"] == "function"
        assert len(balance_of["inputs"]) == 1
        assert balance_of["inputs"][0]["type"] == "address"
        assert balance_of["outputs"][0]["type"] == "uint256"

    def test_transfer_structure(self) -> None:
        transfer = next(e for e in ERC20_ABI if e["name"] == "transfer")
        assert transfer["constant"] is False
        assert len(transfer["inputs"]) == 2
        assert transfer["inputs"][0]["type"] == "address"
        assert transfer["inputs"][1]["type"] == "uint256"
        assert transfer["outputs"][0]["type"] == "bool"

    def test_approve_structure(self) -> None:
        approve = next(e for e in ERC20_ABI if e["name"] == "approve")
        assert approve["constant"] is False
        assert len(approve["inputs"]) == 2
        assert approve["inputs"][0]["type"] == "address"
        assert approve["inputs"][1]["type"] == "uint256"

    def test_allowance_structure(self) -> None:
        allowance = next(e for e in ERC20_ABI if e["name"] == "allowance")
        assert allowance["constant"] is True
        assert len(allowance["inputs"]) == 2
        assert allowance["outputs"][0]["type"] == "uint256"
