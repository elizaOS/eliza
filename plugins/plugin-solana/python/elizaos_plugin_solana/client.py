"""Solana client for RPC operations."""

from decimal import Decimal
from typing import Optional

import httpx
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TokenAccountOpts
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.system_program import TransferParams as SystemTransferParams
from solders.system_program import transfer
from solders.transaction import VersionedTransaction
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import TransferParams as SplTransferParams
from spl.token.instructions import create_associated_token_account, transfer as spl_transfer

from elizaos_plugin_solana.config import WalletConfig
from elizaos_plugin_solana.errors import (
    ConfigError,
    InsufficientBalanceError,
    InvalidPublicKeyError,
    RpcError,
    SwapError,
    TransactionError,
)
from elizaos_plugin_solana.types import (
    BirdeyePriceResponse,
    SwapQuote,
    SwapQuoteParams,
    SwapResult,
    SwapTransaction,
    TokenAccountInfo,
    TransferResult,
)

LAMPORTS_PER_SOL = 1_000_000_000
JUPITER_API_URL = "https://quote-api.jup.ag/v6"
BIRDEYE_API_URL = "https://public-api.birdeye.so"


class SolanaClient:
    """Solana client for blockchain operations.

    This client provides methods for:
    - Querying balances (SOL and SPL tokens)
    - Transferring SOL and SPL tokens
    - Getting swap quotes and executing swaps via Jupiter
    - Fetching token prices via Birdeye

    Example:
        >>> config = WalletConfig.from_env()
        >>> client = SolanaClient(config)
        >>> balance = await client.get_sol_balance()
        >>> print(f"Balance: {balance} SOL")
    """

    def __init__(self, config: WalletConfig) -> None:
        """Initialize the Solana client.

        Args:
            config: Wallet configuration with RPC URL and keys.
        """
        self._config = config
        self._rpc = AsyncClient(config.rpc_url, commitment=Confirmed)
        self._http = httpx.AsyncClient(timeout=30.0)

    @property
    def public_key(self) -> Pubkey:
        """Get the wallet's public key."""
        return self._config.public_key

    async def get_sol_balance(self) -> Decimal:
        """Get SOL balance for the configured wallet.

        Returns:
            Balance in SOL (not lamports).
        """
        return await self.get_sol_balance_for(self._config.public_key)

    async def get_sol_balance_for(self, pubkey: Pubkey) -> Decimal:
        """Get SOL balance for any address.

        Args:
            pubkey: The public key to query.

        Returns:
            Balance in SOL (not lamports).

        Raises:
            RpcError: If the RPC call fails.
        """
        try:
            resp = await self._rpc.get_balance(pubkey)
            if resp.value is None:
                return Decimal(0)
            return Decimal(resp.value) / LAMPORTS_PER_SOL
        except Exception as e:
            raise RpcError(f"Failed to get balance: {e}") from e

    async def get_balances_for_addresses(
        self, addresses: list[str]
    ) -> dict[str, Decimal]:
        """Get SOL balances for multiple addresses.

        Args:
            addresses: List of Base58-encoded addresses.

        Returns:
            Map of address to balance in SOL.
        """
        result: dict[str, Decimal] = {}
        for addr in addresses:
            try:
                pubkey = Pubkey.from_string(addr)
                balance = await self.get_sol_balance_for(pubkey)
                result[addr] = balance
            except Exception:
                result[addr] = Decimal(0)
        return result

    async def get_token_accounts(self) -> list[TokenAccountInfo]:
        """Get token accounts for the configured wallet."""
        return await self.get_token_accounts_for(self._config.public_key)

    async def get_token_accounts_for(
        self, owner: Pubkey
    ) -> list[TokenAccountInfo]:
        """Get token accounts for any address.

        Args:
            owner: Owner's public key.

        Returns:
            List of token account information.
        """
        try:
            resp = await self._rpc.get_token_accounts_by_owner(
                owner, TokenAccountOpts(program_id=TOKEN_PROGRAM_ID)
            )
            accounts: list[TokenAccountInfo] = []
            for item in resp.value:
                # Parse token account data
                data = item.account.data
                if hasattr(data, "parsed"):
                    info = data.parsed.get("info", {})
                    token_amount = info.get("tokenAmount", {})
                    accounts.append(
                        TokenAccountInfo(
                            mint=info.get("mint", ""),
                            owner=info.get("owner", ""),
                            amount=token_amount.get("amount", "0"),
                            decimals=token_amount.get("decimals", 0),
                            ui_amount=Decimal(str(token_amount.get("uiAmount", 0))),
                        )
                    )
            return accounts
        except Exception as e:
            raise RpcError(f"Failed to get token accounts: {e}") from e

    async def transfer_sol(
        self, recipient: Pubkey, amount_sol: Decimal
    ) -> TransferResult:
        """Transfer SOL to another address.

        Args:
            recipient: Recipient's public key.
            amount_sol: Amount in SOL to transfer.

        Returns:
            Transfer result with transaction signature.

        Raises:
            ConfigError: If wallet can't sign.
            InsufficientBalanceError: If balance is too low.
            TransactionError: If transaction fails.
        """
        keypair = self._config.keypair
        lamports = int(amount_sol * LAMPORTS_PER_SOL)

        # Check balance
        balance = await self._rpc.get_balance(keypair.pubkey())
        if balance.value is None or balance.value < lamports:
            raise InsufficientBalanceError(
                required=lamports, available=balance.value or 0
            )

        try:
            # Create transfer instruction
            ix = transfer(
                SystemTransferParams(
                    from_pubkey=keypair.pubkey(),
                    to_pubkey=recipient,
                    lamports=lamports,
                )
            )

            # Get recent blockhash
            blockhash_resp = await self._rpc.get_latest_blockhash()
            blockhash = blockhash_resp.value.blockhash

            # Create and sign transaction
            msg = MessageV0.try_compile(
                keypair.pubkey(), [ix], [], blockhash
            )
            tx = VersionedTransaction(msg, [keypair])

            # Send transaction
            resp = await self._rpc.send_transaction(tx)
            signature = str(resp.value)

            return TransferResult(
                success=True,
                signature=signature,
                amount=str(amount_sol),
                recipient=str(recipient),
            )
        except Exception as e:
            raise TransactionError(f"Transfer failed: {e}") from e

    async def get_swap_quote(self, params: SwapQuoteParams) -> SwapQuote:
        """Get a swap quote from Jupiter.

        Args:
            params: Quote parameters.

        Returns:
            Swap quote from Jupiter.

        Raises:
            SwapError: If quote fetch fails.
        """
        url = (
            f"{JUPITER_API_URL}/quote?"
            f"inputMint={params.input_mint}&"
            f"outputMint={params.output_mint}&"
            f"amount={params.amount}&"
            f"slippageBps={params.slippage_bps}&"
            f"dynamicSlippage=true"
        )

        try:
            resp = await self._http.get(url)
            resp.raise_for_status()
            data = resp.json()
            return SwapQuote.model_validate(data)
        except httpx.HTTPStatusError as e:
            raise SwapError(f"Jupiter API error: {e.response.text}") from e
        except Exception as e:
            raise SwapError(f"Failed to get quote: {e}") from e

    async def execute_swap(self, quote: SwapQuote) -> SwapResult:
        """Execute a swap using Jupiter.

        Args:
            quote: The quote to execute.

        Returns:
            Swap result with transaction signature.

        Raises:
            ConfigError: If wallet can't sign.
            SwapError: If swap execution fails.
        """
        keypair = self._config.keypair

        # Get swap transaction from Jupiter
        swap_request = {
            "quoteResponse": quote.model_dump(by_alias=True),
            "userPublicKey": str(keypair.pubkey()),
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": {
                "priorityLevelWithMaxLamports": {
                    "maxLamports": 4000000,
                    "priorityLevel": "veryHigh",
                }
            },
        }

        try:
            resp = await self._http.post(
                f"{JUPITER_API_URL}/swap",
                json=swap_request,
            )
            resp.raise_for_status()
            swap_tx = SwapTransaction.model_validate(resp.json())

            # Decode and sign the transaction
            import base64
            tx_bytes = base64.b64decode(swap_tx.swap_transaction)
            tx = VersionedTransaction.from_bytes(tx_bytes)

            # Sign the transaction
            tx.sign([keypair])

            # Send transaction
            send_resp = await self._rpc.send_transaction(tx)
            signature = str(send_resp.value)

            return SwapResult(
                success=True,
                signature=signature,
                in_amount=quote.in_amount,
                out_amount=quote.out_amount,
            )
        except httpx.HTTPStatusError as e:
            raise SwapError(f"Jupiter swap API error: {e.response.text}") from e
        except Exception as e:
            raise SwapError(f"Swap execution failed: {e}") from e

    async def get_token_prices(self, mints: list[str]) -> dict[str, float]:
        """Get token prices from Birdeye.

        Args:
            mints: List of token mint addresses.

        Returns:
            Map of mint address to price in USD.

        Raises:
            ConfigError: If Birdeye API key is not configured.
        """
        api_key = self._config.birdeye_api_key
        if not api_key:
            raise ConfigError("BIRDEYE_API_KEY required for price data")

        prices: dict[str, float] = {}
        for mint in mints:
            try:
                resp = await self._http.get(
                    f"{BIRDEYE_API_URL}/defi/price?address={mint}",
                    headers={"X-API-KEY": api_key, "x-chain": "solana"},
                )
                if resp.status_code == 200:
                    data = BirdeyePriceResponse.model_validate(resp.json())
                    if data.success:
                        prices[mint] = data.data.value
            except Exception:
                pass

        return prices

    @staticmethod
    def is_valid_address(address: str) -> bool:
        """Validate a Solana address.

        Args:
            address: Address to validate.

        Returns:
            True if the address is valid.
        """
        try:
            Pubkey.from_string(address)
            return True
        except Exception:
            return False

    @staticmethod
    def is_on_curve(address: str) -> Optional[bool]:
        """Check if an address is on the Ed25519 curve.

        Args:
            address: Address to check.

        Returns:
            True if on curve, False if PDA, None if invalid.
        """
        try:
            pubkey = Pubkey.from_string(address)
            return pubkey.is_on_curve()
        except Exception:
            return None

    async def close(self) -> None:
        """Close the client connections."""
        await self._rpc.close()
        await self._http.aclose()

    async def __aenter__(self) -> "SolanaClient":
        """Async context manager entry."""
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[object],
    ) -> None:
        """Async context manager exit."""
        await self.close()


