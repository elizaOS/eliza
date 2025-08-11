# Quickswap Plugin for ElizaOS

This plugin provides integration with Quickswap, a decentralized exchange on Polygon, enabling AI agents to interact with DeFi functionalities like token swaps, liquidity provision, and transaction status checks.

## Features

- Fetch token data (name, symbol, decimals, address)
- Fetch token pair data (liquidity, reserves, price)
- Simulate token swaps
- Simulate adding liquidity to pools
- Simulate removing liquidity from pools
- Get transaction status by hash
- TypeScript support with comprehensive error handling

## Installation

This plugin is part of the ElizaOS ecosystem. To use it:

```bash
# Install dependencies
npm install

# Build the plugin
npm run build
```

## Configuration

### Required Environment Variables

- **`QUICKSWAP_API_URL`**: Quickswap API endpoint URL (for simulated calls)
  - Default: `https://api.quickswap.exchange`
  - Example: `QUICKSWAP_API_URL=https://api.quickswap.exchange`
  - **Note**: This environment variable activates the plugin in the main Eliza character.
- **`WALLET_PRIVATE_KEY`**: Private key for simulated trading operations (required for swap/liquidity actions).

### Environment Setup

Create a `.env` file in your project root:

```env
QUICKSWAP_API_URL=https://api.quickswap.exchange
WALLET_PRIVATE_KEY=your_private_key_here
```

### Plugin Activation

The plugin is automatically activated when `QUICKSWAP_API_URL` is set in your environment:

```typescript
// In eliza.ts character configuration
...(process.env.QUICKSWAP_API_URL ? ['@elizaos/plugin-quickswap'] : []),
```

This means:

- ✅ **With QUICKSWAP_API_URL set**: Plugin loads automatically, all actions available
- ❌ **Without QUICKSWAP_API_URL**: Plugin remains inactive

## Available Actions

### INITIALIZE_QUICKSWAP_PLUGIN

Initializes the Quickswap Plugin structure and confirms its configuration.

**Triggers**: `INITIALIZE_QUICKSWAP`, `SETUP_QUICKSWAP`, `QUICKSWAP_INIT`

**Usage Examples**:

- "Initialize Quickswap plugin"
- "Setup Quickswap integration"

**Response**: Confirms the plugin is initialized and provides details on configured API URL and wallet status.

### FETCH_TOKEN_DATA

Fetches comprehensive token data (name, symbol, decimals, address) from Quickswap for a given token symbol or address.

**Triggers**: `GET_TOKEN_INFO`, `RETRIEVE_TOKEN_DATA`, `CHECK_TOKEN_DETAILS`, `TOKEN_LOOKUP`, `GET_CRYPTO_INFO`

**Usage Examples**:

- "Get token data for USDC"
- "What are the details of WMATIC?"
- "Fetch token info for 0x2791B072600277340f1aDa76aE19A6C09bED2737"

**Required parameters:**

- Token Symbol or Address

### FETCH_PAIR_DATA

Fetches comprehensive pair data (e.g., liquidity, reserves, price) from Quickswap for a given token pair.

**Triggers**: `GET_PAIR_INFO`, `RETRIEVE_PAIR_DATA`, `CHECK_POOL_DETAILS`, `PAIR_LOOKUP`, `GET_LIQUIDITY_INFO`

**Usage Examples**:

- "Get pair data for USDC and WMATIC"
- "Fetch pool info for WETH-DAI"
- "What's the liquidity for 0x... and 0x...?"

**Required parameters:**

- Two token symbols or addresses

### SWAP_TOKENS

Simulates swapping a specified amount of an input token for an output token on Quickswap.

**Triggers**: `EXCHANGE_TOKENS`, `TRADE_TOKENS`, `PERFORM_SWAP`, `QUICKSWAP_TRADE`, `SWAP`

**Usage Examples**:

- "Swap 100 USDC for WMATIC"
- "Exchange 5 WMATIC for DAI, with at least 4.9 DAI"

**Required parameters:**

- Input token symbol/address
- Output token symbol/address
- Amount to swap

### ADD_LIQUIDITY

Simulates adding liquidity for a specified token pair to a Quickswap pool.

**Triggers**: `ADD_POOL_LIQUIDITY`, `SUPPLY_LIQUIDITY`, `PROVIDE_LIQUIDITY`, `LIQUIDITY_ADD`

**Usage Examples**:

- "Add 10 USDC and 5 WMATIC to the liquidity pool"
- "Provide 1 ETH and 2000 DAI liquidity"

**Required parameters:**

- Two token symbols/addresses
- Amounts for each token

### REMOVE_LIQUIDITY

Simulates removing a specified amount of liquidity (LP tokens) from a Quickswap pool and receiving back the underlying tokens.

**Triggers**: `REMOVE_POOL_LIQUIDITY`, `WITHDRAW_LIQUIDITY`, `UNSTAKE_LP_TOKENS`, `LIQUIDITY_REMOVE`

**Usage Examples**:

- "Remove 10 LP tokens from USDC/WMATIC pool"
- "Withdraw 5 LP tokens from WETH-DAI"

**Required parameters:**

- Two token symbols/addresses
- Amount of LP tokens

### GET_TRANSACTION_STATUS

Simulates fetching the current status of a transaction on Quickswap using its hash.

**Triggers**: `CHECK_TRANSACTION_STATUS`, `GET_TX_STATUS`, `LOOKUP_TRANSACTION`, `VERIFY_TRANSACTION`

**Usage Examples**:

- "Get status for transaction 0x123...abc"
- "Is tx 0xdef...789 confirmed?"

**Required parameters:**

- Transaction Hash
