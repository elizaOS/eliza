# elizaOS Plugin Solana (Python)

Python implementation of the Solana blockchain plugin for elizaOS agents.

## Installation

```bash
pip install elizaos-plugin-solana
```

## Quick Start

```python
import asyncio
from elizaos_plugin_solana import SolanaClient, WalletConfig

async def main():
    # Read-only mode (just need a public key)
    config = WalletConfig.read_only(
        "https://api.mainnet-beta.solana.com",
        "YourPublicKeyHere"
    )

    async with SolanaClient(config) as client:
        # Get SOL balance
        balance = await client.get_sol_balance()
        print(f"Balance: {balance} SOL")

        # Get token accounts
        tokens = await client.get_token_accounts()
        for token in tokens:
            print(f"{token.mint}: {token.ui_amount}")

asyncio.run(main())
```

## With Signing Capability

```python
from elizaos_plugin_solana import SolanaClient, WalletConfig
from decimal import Decimal

# Full access mode (with private key)
config = WalletConfig.with_keypair(
    "https://api.mainnet-beta.solana.com",
    "YourPrivateKeyHere"
)

async with SolanaClient(config) as client:
    # Transfer SOL
    recipient = "RecipientPublicKey"
    result = await client.transfer_sol(recipient, Decimal("0.1"))
    print(f"Transfer signature: {result.signature}")
```

## Environment Variables

Load configuration from environment:

```python
config = WalletConfig.from_env()
```

Required environment variables:

- `SOLANA_RPC_URL` - Solana RPC endpoint (defaults to mainnet)
- `SOLANA_PRIVATE_KEY` or `WALLET_PRIVATE_KEY` - Private key for signing
- `SOLANA_PUBLIC_KEY` or `WALLET_PUBLIC_KEY` - Public key (if no private key)

Optional:

- `SLIPPAGE` - Slippage tolerance in basis points (default: 50)
- `HELIUS_API_KEY` - For enhanced RPC
- `BIRDEYE_API_KEY` - For token price data

## Token Swaps via Jupiter

```python
from elizaos_plugin_solana import SwapQuoteParams

params = SwapQuoteParams(
    input_mint="So11111111111111111111111111111111111111112",  # SOL
    output_mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    amount="1000000000",  # 1 SOL in lamports
    slippage_bps=50,
)

quote = await client.get_swap_quote(params)
print(f"Expected output: {quote.out_amount}")

# Execute the swap
result = await client.execute_swap(quote)
print(f"Swap signature: {result.signature}")
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/ -v

# Run linting
ruff check .
ruff format .

# Run type checking
mypy elizaos_plugin_solana
```

## License

MIT
