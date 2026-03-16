# elizaOS EVM Plugin - Python

Python implementation of the EVM blockchain plugin for elizaOS.

## Features

- **Multi-chain Support**: Interact with Ethereum, Base, Arbitrum, Optimism, Polygon, and more
- **Wallet Management**: Secure private key handling with web3.py
- **Token Operations**: Native and ERC20 token transfers
- **Swaps**: Token swaps via LiFi aggregator
- **Bridges**: Cross-chain token bridges via LiFi
- **Strong Typing**: Full Pydantic validation with fail-fast semantics

## Installation

```bash
pip install elizaos-plugin-evm
```

Or with Poetry:

```bash
poetry add elizaos-plugin-evm
```

## Quick Start

```python
import asyncio
from elizaos_plugin_evm import (
    EVMWalletProvider,
    SupportedChain,
    TransferParams,
    execute_transfer,
)

async def main():
    # Initialize provider with private key
    provider = EVMWalletProvider("your_private_key")

    # Get wallet address
    print(f"Address: {provider.address}")

    # Get balance on mainnet
    balance = await provider.get_balance(SupportedChain.MAINNET)
    print(f"Balance: {balance.native_balance} ETH")

    # Transfer tokens
    params = TransferParams(
        from_chain=SupportedChain.SEPOLIA,
        to_address="0x1234567890123456789012345678901234567890",
        amount="0.01",
    )
    tx_hash = await execute_transfer(provider, params)
    print(f"Transaction: {tx_hash}")

asyncio.run(main())
```

## Supported Chains

| Chain            | ID       | Native Token |
| ---------------- | -------- | ------------ |
| Ethereum Mainnet | 1        | ETH          |
| Sepolia          | 11155111 | ETH          |
| Base             | 8453     | ETH          |
| Base Sepolia     | 84532    | ETH          |
| Arbitrum         | 42161    | ETH          |
| Optimism         | 10       | ETH          |
| Polygon          | 137      | MATIC        |
| Avalanche        | 43114    | AVAX         |
| BSC              | 56       | BNB          |
| Gnosis           | 100      | xDAI         |
| Fantom           | 250      | FTM          |
| Linea            | 59144    | ETH          |
| Scroll           | 534352   | ETH          |
| zkSync Era       | 324      | ETH          |

## API Reference

### EVMWalletProvider

The main class for interacting with EVM chains.

```python
from elizaos_plugin_evm import EVMWalletProvider, SupportedChain

# Initialize
provider = EVMWalletProvider(private_key="0x...")

# Get address
address = provider.address

# Get balance
balance = await provider.get_balance(SupportedChain.MAINNET)

# Get token balance
token_balance = await provider.get_token_balance(
    chain=SupportedChain.MAINNET,
    token_address="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  # USDC
)

# Send transaction
tx_hash = await provider.send_transaction(
    chain=SupportedChain.MAINNET,
    to="0x...",
    value=1000000000000000000,  # 1 ETH in wei
)

# Wait for confirmation
await provider.wait_for_transaction(SupportedChain.MAINNET, tx_hash)
```

### Actions

#### Transfer

```python
from elizaos_plugin_evm import TransferParams, execute_transfer

params = TransferParams(
    from_chain=SupportedChain.MAINNET,
    to_address="0x...",
    amount="1.5",
    token="0x...",  # Optional: ERC20 token address
)
tx_hash = await execute_transfer(provider, params)
```

#### Swap

```python
from elizaos_plugin_evm import SwapParams, execute_swap

params = SwapParams(
    chain=SupportedChain.MAINNET,
    from_token="0x0000000000000000000000000000000000000000",  # ETH
    to_token="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  # USDC
    amount="1000000000000000000",  # 1 ETH
    slippage=0.01,  # 1%
)
tx_hash = await execute_swap(provider, params)
```

#### Bridge

```python
from elizaos_plugin_evm import BridgeParams, execute_bridge

params = BridgeParams(
    from_chain=SupportedChain.MAINNET,
    to_chain=SupportedChain.BASE,
    from_token="0x0000000000000000000000000000000000000000",  # ETH
    to_token="0x0000000000000000000000000000000000000000",  # ETH
    amount="1000000000000000000",  # 1 ETH
)
status = await execute_bridge(provider, params)
print(f"Bridge complete: {status.dest_tx_hash}")
```

## Type Validation

All parameters are validated using Pydantic with strict type checking:

```python
from elizaos_plugin_evm import TransferParams, SupportedChain
from pydantic import ValidationError

# This will raise ValidationError
try:
    params = TransferParams(
        from_chain=SupportedChain.MAINNET,
        to_address="invalid_address",  # Invalid!
        amount="0",  # Invalid! Must be positive
    )
except ValidationError as e:
    print(e)
```

## Error Handling

All errors are raised as `EVMError` with specific error codes:

```python
from elizaos_plugin_evm import EVMError, EVMErrorCode

try:
    await execute_transfer(provider, params)
except EVMError as e:
    if e.code == EVMErrorCode.INSUFFICIENT_FUNDS:
        print("Not enough funds!")
    elif e.code == EVMErrorCode.ROUTE_NOT_FOUND:
        print("No swap route found")
    else:
        print(f"Error: {e.message}")
```

## Testing

Run unit tests:

```bash
pytest tests/test_types.py -v
```

Run integration tests (requires funded wallet):

```bash
export EVM_PRIVATE_KEY="your_testnet_private_key"
pytest tests/test_integration.py -v
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run linter
ruff check .

# Run type checker
mypy elizaos_plugin_evm

# Format code
ruff format .
```

## License

MIT
