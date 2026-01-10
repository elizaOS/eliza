"""
EVM Wallet Provider using web3.py.
"""

import logging
from decimal import Decimal

from eth_account import Account
from eth_account.signers.local import LocalAccount
from web3 import AsyncHTTPProvider, AsyncWeb3
from web3.exceptions import ContractLogicError, Web3RPCError
from web3.types import TxParams, Wei

from elizaos_plugin_evm.constants import (
    DEFAULT_DECIMALS,
    ERC20_ABI,
    GAS_BUFFER_MULTIPLIER,
    NATIVE_TOKEN_ADDRESS,
)
from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.types import (
    SupportedChain,
    TokenInfo,
    TokenWithBalance,
    WalletBalance,
)

logger = logging.getLogger(__name__)


class EVMWalletProvider:
    """EVM wallet provider using web3.py."""

    def __init__(self, private_key: str) -> None:
        """
        Initialize the wallet provider.

        Args:
            private_key: The private key in hex format (with or without 0x prefix).

        Raises:
            EVMError: If the private key is invalid.
        """
        if not private_key:
            raise EVMError.invalid_params("Private key is required")

        # Normalize the private key
        key = private_key if private_key.startswith("0x") else f"0x{private_key}"

        try:
            self._account: LocalAccount = Account.from_key(key)
        except Exception as e:
            raise EVMError.invalid_params(f"Invalid private key: {e}") from e

        self._clients: dict[SupportedChain, AsyncWeb3] = {}

    @property
    def address(self) -> str:
        """Get the wallet address."""
        return self._account.address

    async def get_client(self, chain: SupportedChain) -> AsyncWeb3:
        """
        Get or create an async web3 client for the given chain.

        Args:
            chain: The chain to get a client for.

        Returns:
            The web3 client instance.
        """
        if chain not in self._clients:
            provider = AsyncHTTPProvider(chain.default_rpc)
            client = AsyncWeb3(provider)
            self._clients[chain] = client

        return self._clients[chain]

    async def get_balance(self, chain: SupportedChain) -> WalletBalance:
        """
        Get the wallet balance for a specific chain.

        Args:
            chain: The chain to get balance for.

        Returns:
            WalletBalance containing native and token balances.
        """
        client = await self.get_client(chain)
        address = self._account.address

        try:
            balance_wei = await client.eth.get_balance(address)
            balance_eth = client.from_wei(balance_wei, "ether")

            return WalletBalance(
                chain=chain,
                address=address,
                native_balance=str(balance_eth),
                tokens=[],
            )
        except Exception as e:
            raise EVMError.network_error(f"Failed to get balance: {e}") from e

    async def get_token_balance(
        self,
        chain: SupportedChain,
        token_address: str,
    ) -> TokenWithBalance:
        """
        Get the balance of a specific token.

        Args:
            chain: The chain the token is on.
            token_address: The token contract address.

        Returns:
            TokenWithBalance with the token balance info.
        """
        client = await self.get_client(chain)
        address = self._account.address

        # Create contract instance
        checksum_token = client.to_checksum_address(token_address)
        contract = client.eth.contract(address=checksum_token, abi=ERC20_ABI)

        try:
            # Fetch token info and balance in parallel
            balance = await contract.functions.balanceOf(address).call()
            decimals = await contract.functions.decimals().call()
            symbol = await contract.functions.symbol().call()

            # Format balance
            formatted = Decimal(balance) / Decimal(10**decimals)

            token_info = TokenInfo(
                address=token_address,
                symbol=symbol,
                name=symbol,  # Using symbol as name for simplicity
                decimals=decimals,
                chain_id=chain.chain_id,
            )

            return TokenWithBalance(
                token=token_info,
                balance=balance,
                formatted_balance=str(formatted),
            )
        except Exception as e:
            raise EVMError.network_error(f"Failed to get token balance: {e}") from e

    async def send_transaction(
        self,
        chain: SupportedChain,
        to: str,
        value: int,
        data: str | None = None,
    ) -> str:
        """
        Send a transaction on the given chain.

        Args:
            chain: The chain to send the transaction on.
            to: The recipient address.
            value: The value in wei.
            data: Optional transaction data.

        Returns:
            The transaction hash.

        Raises:
            EVMError: If the transaction fails.
        """
        client = await self.get_client(chain)
        address = self._account.address

        try:
            # Get nonce
            nonce = await client.eth.get_transaction_count(address)

            # Build transaction
            tx: TxParams = {
                "from": address,
                "to": client.to_checksum_address(to),
                "value": Wei(value),
                "nonce": nonce,
                "chainId": chain.chain_id,
            }

            if data:
                tx["data"] = data

            # Estimate gas with buffer
            gas_estimate = await client.eth.estimate_gas(tx)
            tx["gas"] = int(gas_estimate * GAS_BUFFER_MULTIPLIER)

            # Get gas price
            gas_price = await client.eth.gas_price
            tx["gasPrice"] = gas_price

            # Sign transaction
            signed = self._account.sign_transaction(tx)

            # Send transaction
            tx_hash = await client.eth.send_raw_transaction(signed.raw_transaction)

            return tx_hash.hex()
        except ContractLogicError as e:
            raise EVMError.transaction_failed(f"Contract reverted: {e}") from e
        except Web3RPCError as e:
            if "insufficient funds" in str(e).lower():
                raise EVMError.insufficient_funds(str(e)) from e
            raise EVMError.network_error(f"RPC error: {e}") from e
        except Exception as e:
            raise EVMError.transaction_failed(f"Transaction failed: {e}") from e

    async def send_token(
        self,
        chain: SupportedChain,
        token_address: str,
        to: str,
        amount: int,
    ) -> str:
        """
        Send ERC20 tokens.

        Args:
            chain: The chain to send on.
            token_address: The token contract address.
            to: The recipient address.
            amount: The amount in token units (wei).

        Returns:
            The transaction hash.
        """
        client = await self.get_client(chain)
        address = self._account.address

        # Create contract instance
        checksum_token = client.to_checksum_address(token_address)
        contract = client.eth.contract(address=checksum_token, abi=ERC20_ABI)

        try:
            # Build transfer call
            transfer_data = contract.encodeABI(
                fn_name="transfer",
                args=[client.to_checksum_address(to), amount],
            )

            # Send as regular transaction
            return await self.send_transaction(
                chain=chain,
                to=token_address,
                value=0,
                data=transfer_data,
            )
        except EVMError:
            raise
        except Exception as e:
            raise EVMError.transaction_failed(f"Token transfer failed: {e}") from e

    async def approve_token(
        self,
        chain: SupportedChain,
        token_address: str,
        spender: str,
        amount: int,
    ) -> str:
        """
        Approve a spender to spend tokens.

        Args:
            chain: The chain to approve on.
            token_address: The token contract address.
            spender: The spender address.
            amount: The amount to approve (in token units).

        Returns:
            The transaction hash.
        """
        client = await self.get_client(chain)

        # Create contract instance
        checksum_token = client.to_checksum_address(token_address)
        contract = client.eth.contract(address=checksum_token, abi=ERC20_ABI)

        try:
            approve_data = contract.encodeABI(
                fn_name="approve",
                args=[client.to_checksum_address(spender), amount],
            )

            return await self.send_transaction(
                chain=chain,
                to=token_address,
                value=0,
                data=approve_data,
            )
        except EVMError:
            raise
        except Exception as e:
            raise EVMError.transaction_failed(f"Approval failed: {e}") from e

    async def get_allowance(
        self,
        chain: SupportedChain,
        token_address: str,
        spender: str,
    ) -> int:
        """
        Get the token allowance for a spender.

        Args:
            chain: The chain to check on.
            token_address: The token contract address.
            spender: The spender address.

        Returns:
            The allowance amount.
        """
        client = await self.get_client(chain)
        address = self._account.address

        checksum_token = client.to_checksum_address(token_address)
        contract = client.eth.contract(address=checksum_token, abi=ERC20_ABI)

        try:
            allowance: int = await contract.functions.allowance(
                address, client.to_checksum_address(spender)
            ).call()
            return allowance
        except Exception as e:
            raise EVMError.network_error(f"Failed to get allowance: {e}") from e

    async def wait_for_transaction(
        self,
        chain: SupportedChain,
        tx_hash: str,
        timeout: int = 60,
    ) -> bool:
        """
        Wait for a transaction to be confirmed.

        Args:
            chain: The chain the transaction is on.
            tx_hash: The transaction hash.
            timeout: Timeout in seconds.

        Returns:
            True if confirmed successfully.

        Raises:
            EVMError: If the transaction failed or timed out.
        """
        client = await self.get_client(chain)

        try:
            receipt = await client.eth.wait_for_transaction_receipt(
                tx_hash,
                timeout=timeout,
            )

            if receipt["status"] == 0:
                raise EVMError.transaction_failed("Transaction reverted")

            return True
        except EVMError:
            raise
        except Exception as e:
            raise EVMError.transaction_failed(f"Wait failed: {e}") from e


