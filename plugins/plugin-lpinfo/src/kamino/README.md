# Kamino Lending Protocol Plugin

This plugin provides comprehensive integration with the Kamino lending protocol on Solana, allowing users to view their lending and borrowing positions, market data, and available opportunities.

## Features

### 📊 Position Tracking
- **Lending Positions**: View all your active lending positions across Kamino markets
- **Borrowing Positions**: Track your borrowing positions and interest rates
- **Portfolio Value**: Calculate total portfolio value including lending and borrowing
- **Multi-Wallet Support**: View positions for all Solana wallets in your account

### 🏦 Market Data
- **Available Reserves**: Browse all available lending and borrowing opportunities
- **APY Rates**: View current supply and borrow APY rates
- **Market Overview**: Get comprehensive market statistics and TVL data
- **Top Opportunities**: Identify the best lending opportunities by APY

### 📈 Analytics
- **Market Utilization**: Track utilization rates across different markets
- **Total Value Locked**: Monitor TVL across all Kamino markets
- **Borrowing Activity**: View total borrowed amounts and market health

## Usage

The Kamino plugin is designed to work in private messages (DMs) for security. When you send a message in a DM, the plugin will automatically:

1. **Extract your wallet addresses** from your connected Solana wallets
2. **Fetch your positions** from all Kamino markets
3. **Display a comprehensive report** including:
   - Your lending and borrowing positions
   - Available lending opportunities
   - Market overview and statistics

## Provider Information

The plugin provides the following information through the `KAMINO_LENDING` provider:

### User Positions
- **Lending Positions**: Token, amount, value, APY, and market for each position
- **Borrowing Positions**: Token, amount, value, APY, and market for each position
- **Total Portfolio Value**: Net value of all positions

### Available Reserves
- **Top Lending Opportunities**: Highest APY lending options
- **Reserve Details**: Supply/borrow APY, total supply/borrow, utilization rates
- **Market Information**: Which market each reserve belongs to

### Market Overview
- **Total Markets**: Number of active Kamino markets
- **Total TVL**: Combined total value locked across all markets
- **Total Borrowed**: Total amount borrowed across all markets
- **Top Markets**: Markets with highest TVL

## Technical Details

### Dependencies
- `@solana/web3.js`: Solana blockchain interaction
- `@hubbleprotocol/kamino-sdk`: Official Kamino SDK for protocol interaction

### Environment Variables
- `SOLANA_RPC_URL`: Solana RPC endpoint (defaults to mainnet-beta)

### Service Architecture
- **KaminoService**: Handles all Kamino protocol interactions
- **Provider**: Formats and presents data to the agent
- **Account Integration**: Uses existing account system for wallet management

## Security

- **Private Messages Only**: Position data is only available in DMs
- **Account Verification**: Requires verified account with connected wallets
- **No Private Keys**: Only uses public wallet addresses for queries

## Error Handling

The plugin includes comprehensive error handling for:
- Network connectivity issues
- Invalid wallet addresses
- Missing account data
- API rate limits
- Market data unavailability

## Future Enhancements

Potential future features:
- Position management actions (deposit, withdraw, borrow, repay)
- Yield optimization recommendations
- Historical position tracking
- Risk assessment and alerts
- Integration with other DeFi protocols
