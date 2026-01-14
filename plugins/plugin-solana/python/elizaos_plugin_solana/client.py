from decimal import Decimal

import httpx
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TokenAccountOpts
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.system_program import TransferParams as SystemTransferParams
from solders.system_program import transfer
from solders.transaction import VersionedTransaction
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import TransferParams as SplTransferParams
from spl.token.instructions import (
    create_associated_token_account,
    get_associated_token_address,
)
from spl.token.instructions import (
    transfer as spl_transfer,
)

from elizaos_plugin_solana.config import WalletConfig
from elizaos_plugin_solana.errors import (
    ConfigError,
    InsufficientBalanceError,
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
    def __init__(self, config: WalletConfig) -> None:
        self._config = config
        self._rpc = AsyncClient(config.rpc_url, commitment=Confirmed)
        self._http = httpx.AsyncClient(timeout=30.0)

    @property
    def public_key(self) -> Pubkey:
        return self._config.public_key

    async def get_sol_balance(self) -> Decimal:
        return await self.get_sol_balance_for(self._config.public_key)

    async def get_sol_balance_for(self, pubkey: Pubkey) -> Decimal:
        try:
            resp = await self._rpc.get_balance(pubkey)
            if resp.value is None:
                return Decimal(0)
            return Decimal(resp.value) / LAMPORTS_PER_SOL
        except Exception as e:
            raise RpcError(f"Failed to get balance: {e}") from e

    async def get_balances_for_addresses(self, addresses: list[str]) -> dict[str, Decimal]:
        result: dict[str, Decimal] = {}
        for addr in addresses:
            pubkey = Pubkey.from_string(addr)
            balance = await self.get_sol_balance_for(pubkey)
            result[addr] = balance
        return result

    async def get_token_accounts(self) -> list[TokenAccountInfo]:
        return await self.get_token_accounts_for(self._config.public_key)

    async def get_token_accounts_for(self, owner: Pubkey) -> list[TokenAccountInfo]:
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

    async def transfer_sol(self, recipient: Pubkey, amount_sol: Decimal) -> TransferResult:
        keypair = self._config.keypair
        lamports = int(amount_sol * LAMPORTS_PER_SOL)

        balance = await self._rpc.get_balance(keypair.pubkey())
        if balance.value is None or balance.value < lamports:
            raise InsufficientBalanceError(required=lamports, available=balance.value or 0)

        try:
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

            msg = MessageV0.try_compile(keypair.pubkey(), [ix], [], blockhash)
            tx = VersionedTransaction(msg, [keypair])

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

    async def transfer_token(
        self, mint: Pubkey, recipient: Pubkey, amount: Decimal
    ) -> TransferResult:
        keypair = self._config.keypair

        try:
            mint_info = await self._rpc.get_account_info(mint)
            if mint_info.value is None:
                raise TransactionError(f"Mint account not found: {mint}")

            mint_data = mint_info.value.data
            if hasattr(mint_data, "__len__") and len(mint_data) >= 45:
                decimals = mint_data[44] if isinstance(mint_data, bytes | list) else 9
            else:
                decimals = 9

            raw_amount = int(amount * Decimal(10**decimals))

            source_ata = get_associated_token_address(keypair.pubkey(), mint)
            dest_ata = get_associated_token_address(recipient, mint)

            instructions = []

            dest_account = await self._rpc.get_account_info(dest_ata)
            if dest_account.value is None:
                instructions.append(
                    create_associated_token_account(
                        keypair.pubkey(),  # payer
                        recipient,  # owner
                        mint,  # mint
                    )
                )

            # Add transfer instruction
            instructions.append(
                spl_transfer(
                    SplTransferParams(
                        program_id=TOKEN_PROGRAM_ID,
                        source=source_ata,
                        dest=dest_ata,
                        owner=keypair.pubkey(),
                        amount=raw_amount,
                    )
                )
            )

            # Get recent blockhash
            blockhash_resp = await self._rpc.get_latest_blockhash()
            blockhash = blockhash_resp.value.blockhash

            msg = MessageV0.try_compile(keypair.pubkey(), instructions, [], blockhash)
            tx = VersionedTransaction(msg, [keypair])

            # Send transaction
            resp = await self._rpc.send_transaction(tx)
            signature = str(resp.value)

            return TransferResult(
                success=True,
                signature=signature,
                amount=str(amount),
                recipient=str(recipient),
            )
        except TransactionError:
            raise
        except Exception as e:
            raise TransactionError(f"Token transfer failed: {e}") from e

    async def get_swap_quote(self, params: SwapQuoteParams) -> SwapQuote:
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

            import base64

            tx_bytes = base64.b64decode(swap_tx.swap_transaction)
            tx = VersionedTransaction.from_bytes(tx_bytes)

            tx.sign([keypair])

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
        api_key = self._config.birdeye_api_key
        if not api_key:
            raise ConfigError("BIRDEYE_API_KEY required for price data")

        prices: dict[str, float] = {}
        for mint in mints:
            resp = await self._http.get(
                f"{BIRDEYE_API_URL}/defi/price?address={mint}",
                headers={"X-API-KEY": api_key, "x-chain": "solana"},
            )
            if resp.status_code == 200:
                data = BirdeyePriceResponse.model_validate(resp.json())
                if data.success:
                    prices[mint] = data.data.value

        return prices

    @staticmethod
    def is_valid_address(address: str) -> bool:
        try:
            Pubkey.from_string(address)
            return True
        except Exception:
            return False

    @staticmethod
    def is_on_curve(address: str) -> bool | None:
        try:
            pubkey = Pubkey.from_string(address)
            return pubkey.is_on_curve()
        except Exception:
            return None

    async def close(self) -> None:
        await self._rpc.close()
        await self._http.aclose()

    async def __aenter__(self) -> "SolanaClient":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object | None,
    ) -> None:
        await self.close()
