import logging
import secrets
from dataclasses import dataclass
from decimal import Decimal

from eth_account import Account
from eth_account.signers.local import LocalAccount
from web3 import AsyncHTTPProvider, AsyncWeb3
from web3.exceptions import ContractLogicError, Web3RPCError
from web3.types import TxParams, Wei

from elizaos_plugin_evm.constants import (
    ERC20_ABI,
    GAS_BUFFER_MULTIPLIER,
)
from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.types import (
    SupportedChain,
    TokenInfo,
    TokenWithBalance,
    WalletBalance,
)

logger = logging.getLogger(__name__)


@dataclass
class GeneratedKey:
    private_key: str
    address: str


def generate_private_key() -> GeneratedKey:
    private_key_bytes = secrets.token_bytes(32)
    private_key = f"0x{private_key_bytes.hex()}"
    account = Account.from_key(private_key)

    logger.warning("═" * 67)
    logger.warning("⚠️  No private key provided - generating new wallet")
    logger.warning(f"📍 New wallet address: {account.address}")
    logger.warning("💾 Please save the private key securely!")
    logger.warning("⚠️  IMPORTANT: Back up your private key for production use!")
    logger.warning("═" * 67)

    return GeneratedKey(private_key=private_key, address=account.address)


class EVMWalletProvider:
    def __init__(self, private_key: str | None = None) -> None:
        self._generated_key: GeneratedKey | None = None

        if not private_key:
            self._generated_key = generate_private_key()
            key = self._generated_key.private_key
        else:
            key = private_key if private_key.startswith("0x") else f"0x{private_key}"

        try:
            self._account: LocalAccount = Account.from_key(key)
        except Exception as e:
            raise EVMError.invalid_params(f"Invalid private key: {e}") from e

        self._clients: dict[SupportedChain, AsyncWeb3] = {}

    @property
    def was_auto_generated(self) -> bool:
        return self._generated_key is not None

    @property
    def generated_key(self) -> GeneratedKey | None:
        return self._generated_key

    @property
    def address(self) -> str:
        return self._account.address

    async def get_client(self, chain: SupportedChain) -> AsyncWeb3:
        if chain not in self._clients:
            provider = AsyncHTTPProvider(chain.default_rpc)
            client = AsyncWeb3(provider)
            self._clients[chain] = client

        return self._clients[chain]

    async def get_balance(self, chain: SupportedChain) -> WalletBalance:
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
        client = await self.get_client(chain)
        address = self._account.address
        checksum_token = client.to_checksum_address(token_address)
        contract = client.eth.contract(address=checksum_token, abi=ERC20_ABI)

        try:
            balance = await contract.functions.balanceOf(address).call()
            decimals = await contract.functions.decimals().call()
            symbol = await contract.functions.symbol().call()
            formatted = Decimal(balance) / Decimal(10**decimals)

            token_info = TokenInfo(
                address=token_address,
                symbol=symbol,
                name=symbol,
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
        client = await self.get_client(chain)
        address = self._account.address

        try:
            nonce = await client.eth.get_transaction_count(address)
            tx: TxParams = {
                "from": address,
                "to": client.to_checksum_address(to),
                "value": Wei(value),
                "nonce": nonce,
                "chainId": chain.chain_id,
            }

            if data:
                tx["data"] = data

            gas_estimate = await client.eth.estimate_gas(tx)
            tx["gas"] = int(gas_estimate * GAS_BUFFER_MULTIPLIER)
            gas_price = await client.eth.gas_price
            tx["gasPrice"] = gas_price
            signed = self._account.sign_transaction(tx)
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
        client = await self.get_client(chain)
        checksum_token = client.to_checksum_address(token_address)
        contract = client.eth.contract(address=checksum_token, abi=ERC20_ABI)

        try:
            transfer_data = contract.encodeABI(
                fn_name="transfer",
                args=[client.to_checksum_address(to), amount],
            )

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
        client = await self.get_client(chain)
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
