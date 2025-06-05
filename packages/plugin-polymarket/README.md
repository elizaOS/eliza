# Polymarket Plugin for ElizaOS

This plugin provides integration with Polymarket prediction markets through the CLOB (Central Limit Order Book) API, enabling AI agents to interact with prediction markets.

## Features

- Retrieve all available prediction markets
- Get simplified market data with reduced schema
- Query market data and pricing information
- Support for market filtering and pagination
- Real-time market data access
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

- **`CLOB_API_URL`**: Polymarket CLOB API endpoint URL
  - Default: `https://clob.polymarket.com`
  - Example: `CLOB_API_URL=https://clob.polymarket.com`
  - **Note**: This environment variable activates the plugin in the main Eliza character

### Optional Environment Variables

- **`CLOB_API_KEY`**: API key for authenticated requests (optional for read-only operations)
- **`POLYMARKET_PRIVATE_KEY`**: Private key for trading operations (required for order placement)

### Environment Setup

Create a `.env` file in your project root:

```env
CLOB_API_URL=https://clob.polymarket.com
CLOB_API_KEY=your_api_key_here
POLYMARKET_PRIVATE_KEY=your_private_key_here
```

### Plugin Activation

The plugin is automatically activated when `CLOB_API_URL` is set in your environment. This follows the same pattern as other ElizaOS plugins:

```typescript
// In eliza.ts character configuration
...(process.env.CLOB_API_URL ? ['@elizaos/plugin-polymarket'] : []),
```

This means:

- ✅ **With CLOB_API_URL set**: Plugin loads automatically, all actions available
- ❌ **Without CLOB_API_URL**: Plugin remains inactive

## Available Actions

### GET_ALL_MARKETS

Retrieves all available prediction markets from Polymarket.

**Triggers**: `LIST_MARKETS`, `SHOW_MARKETS`, `GET_MARKETS`, `FETCH_MARKETS`, `ALL_MARKETS`, `AVAILABLE_MARKETS`

**Usage Examples**:

- "Show me all available prediction markets"
- "What markets can I trade on Polymarket?"
- "List all active prediction markets"

**Response**: Returns formatted list of markets with:

- Market questions and categories
- Active status and end dates
- Token information and trading details
- Pagination support for large result sets

**Example Response**:

```
📊 Retrieved 150 Polymarket prediction markets

Sample Markets:
1. Will BTC reach $100k by end of 2024?
   • Category: crypto
   • Active: ✅
   • End Date: 12/31/2024

2. Who will win the 2024 US Presidential Election?
   • Category: politics
   • Active: ✅
   • End Date: 11/5/2024

... and 148 more markets

Summary:
• Total Markets: 150
• Data includes: question, category, tokens, rewards, and trading details
```

### GET_SIMPLIFIED_MARKETS

Retrieves simplified market data with reduced schema for faster processing and lower bandwidth usage.

**Triggers**: `LIST_SIMPLIFIED_MARKETS`, `SHOW_SIMPLIFIED_MARKETS`, `GET_SIMPLE_MARKETS`, `FETCH_SIMPLIFIED_MARKETS`, `SIMPLIFIED_MARKETS`, `SIMPLE_MARKETS`

**Usage Examples**:

- "Show me simplified market data"
- "Get markets in simplified format"
- "I need simple market data for analysis"

**Benefits**:

- Reduced data payload for faster responses
- Lower bandwidth usage
- Streamlined fields for basic market information
- Ideal for high-frequency data access

**Simplified Schema Includes**:

- Condition ID and token pairs
- Active/closed status
- Rewards and incentive information
- Essential market identification data

**Example Response**:

```
📊 Retrieved 75 Simplified Polymarket markets

Sample Simplified Markets:
1. Condition ID: 0x1234567890abcdef1234567890abcdef12345678
   • Tokens: Yes (12345678...) / No (09876543...)
   • Active: ✅
   • Closed: ❌
   • Min Incentive Size: 0.1

2. Condition ID: 0xabcdef1234567890abcdef1234567890abcdef12
   • Tokens: Yes (87654321...) / No (21098765...)
   • Active: ✅
   • Closed: ❌
   • Min Incentive Size: 0.05

... and 73 more simplified markets

Summary:
• Total Simplified Markets: 75
• Simplified schema includes: condition_id, tokens, rewards, incentives, status
• Reduced data for faster processing and lower bandwidth
```

**TypeScript Usage**:

```typescript
import { getSimplifiedMarketsAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getSimplifiedMarketsAction.handler(runtime, message, state);

// Access simplified market data
const markets = result.data.markets; // SimplifiedMarket[]
```

### GET_CLOB_MARKETS

Retrieves Polymarket markets available for trading via CLOB (Central Limit Order Book). All markets returned by this action are CLOB-enabled and ready for order placement and execution.

**Triggers**: `CLOB_MARKETS`, `GET_CLOB_MARKETS`, `TRADING_MARKETS`, `TRADEABLE_MARKETS`, `MARKETS_FOR_TRADING`, `CLOB_ENABLED`, `TRADING_ENABLED`, `ACTIVE_TRADING`, `CLOB_TRADING`, `ORDER_BOOK_MARKETS`, `AVAILABLE_FOR_TRADING`, `GET_TRADING_MARKETS`, `SHOW_CLOB_MARKETS`, `LIST_CLOB_MARKETS`, `FETCH_CLOB_MARKETS`, `CLOB_AVAILABLE`, `TRADING_AVAILABLE`, `ORDERBOOK_MARKETS`

**Usage Examples**:

- "Show me markets available for trading"
- "Get CLOB markets for politics category"
- "List active trading markets with limit 10"
- "What markets can I place orders on?"

**Optional Parameters**:

- **category**: Filter markets by category (e.g., "politics", "crypto", "sports")
- **active**: Filter by active status (true/false)
- **limit**: Maximum number of markets to return

**Response**: Returns formatted list of CLOB-enabled markets with:

- Market questions and categories
- Trading status (active/inactive)
- Token information and outcomes
- Minimum order size and tick size for trading
- Total count and pagination information
- Filter information when applied

**Example Response**:

```
📈 CLOB Markets (Trading Available)

Found 150 markets ready for trading:

🎯 Will Donald Trump win the 2024 election?
├─ Category: Politics
├─ Trading: ✅ Active
├─ Tokens: Yes | No
└─ Min Order: $0.01 • Min Tick: $0.01

🎯 Will Bitcoin reach $100k by end of 2024?
├─ Category: Crypto
├─ Trading: ✅ Active
├─ Tokens: Yes | No
└─ Min Order: $0.01 • Min Tick: $0.01

🎯 Will Lakers make NBA playoffs?
├─ Category: Sports
├─ Trading: ✅ Active
├─ Tokens: Yes | No
└─ Min Order: $0.01 • Min Tick: $0.01

... and 147 more markets

📊 Total: 150 tradeable markets • All CLOB-enabled
🔧 Filters Applied: category=politics, active=true
📄 Next: Use cursor ABC123 for more markets
```

**TypeScript Usage**:

```typescript
import { getClobMarkets } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getClobMarkets.handler(runtime, message, state);

// Access CLOB markets data
const markets = result.data.markets; // Market[]
const totalCount = result.data.count; // number
const nextCursor = result.data.next_cursor; // string
const filters = result.data.filters; // ClobMarketsParams
```

**CLOB Market Schema**:

```typescript
interface ClobMarketsParams {
  category?: string;
  active?: boolean;
  limit?: number;
}

interface ClobMarketsResponse {
  markets: Market[];
  count: number;
  next_cursor?: string;
  filters: ClobMarketsParams;
  timestamp: string;
}

interface Market {
  condition_id: string;
  question: string;
  category: string;
  active: boolean;
  tokens: Token[];
  minimum_order_size: string;
  minimum_tick_size: string;
  // ... additional market fields
}
```

**Key Features**:

- **CLOB-Ready**: All returned markets support order placement
- **Trading Information**: Includes minimum order and tick sizes
- **Active Status**: Shows which markets are currently trading
- **Filter Support**: Category, active status, and limit filters
- **Pagination**: Handle large result sets efficiently
- **Real-time Data**: Current trading status and parameters

**Benefits**:

- Identify markets ready for order placement
- Access trading parameters (min order/tick sizes)
- Filter markets by category or trading status
- Efficient discovery of tradeable opportunities
- Integration with order placement workflows

### GET_PRICE_HISTORY

Retrieves historical price data for a Polymarket token, providing time-series data with timestamps and prices for technical analysis and trend identification.

**Triggers**: `PRICE_HISTORY`, `GET_PRICE_HISTORY`, `PRICES_HISTORY`, `HISTORICAL_PRICES`, `PRICE_CHART`, `PRICE_DATA`, `CHART_DATA`, `HISTORICAL_DATA`, `TIME_SERIES`, `PRICE_TIMELINE`, `MARKET_HISTORY`, `TOKEN_HISTORY`, `PRICE_TREND`, `HISTORICAL_CHART`, `SHOW_PRICE_HISTORY`, `FETCH_PRICE_HISTORY`, `GET_HISTORICAL_PRICES`, `SHOW_HISTORICAL_PRICES`

**Usage Examples**:

- "Get price history for token 123456 with 1d interval"
- "Show me 1h price chart for token 456789"
- "PRICE_HISTORY 789012"
- "Historical prices for token 345678 over 1 week"

**Required Parameters**:

- **tokenId**: The specific token ID for which to retrieve price history (numeric string)
- **interval**: Time interval for data points (optional, defaults to "1d")
  - Supported intervals: "1m", "5m", "1h", "6h", "1d", "1w", "max"

**Response**: Returns comprehensive price history analysis including:

- Time-series data with timestamps and prices
- Price trend calculation (percentage change over period)
- Highest and lowest prices in the dataset
- Recent price points (last 5 data points)
- Time range coverage
- Data point count

**Example Response**:

```
📈 **Price History for Token 123456**

⏱️ **Interval**: 1d
📊 **Data Points**: 30

**Recent Price Points:**
• 2024-01-15 12:00:00 - $0.6523 (65.23%)
• 2024-01-14 12:00:00 - $0.6445 (64.45%)
• 2024-01-13 12:00:00 - $0.6387 (63.87%)
• 2024-01-12 12:00:00 - $0.6234 (62.34%)
• 2024-01-11 12:00:00 - $0.6156 (61.56%)

📈 **Price Trend**: +2.78% over the period
💹 **Highest**: $0.6789 (67.89%)
📉 **Lowest**: $0.5923 (59.23%)

🕒 **Time Range**: Jan 15, 2024 - Dec 16, 2023
```

**TypeScript Usage**:

```typescript
import { getPriceHistory } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getPriceHistory.handler(runtime, message, state);

// Access price history data
const priceHistory = result.data.priceHistory; // PricePoint[]
const tokenId = result.data.tokenId; // string
const interval = result.data.interval; // string
const pointsCount = result.data.pointsCount; // number
```

**Price History Schema**:

```typescript
interface PricePoint {
  t: number; // Unix timestamp
  p: number; // Price (0-1 representing probability)
}

interface PriceHistoryResponse {
  tokenId: string;
  interval: string;
  priceHistory: PricePoint[];
  pointsCount: number;
  timestamp: string;
}
```

**Key Features**:

- **Multiple Intervals**: Support for various time granularities
- **Trend Analysis**: Automatic calculation of price trends
- **Statistical Summary**: High, low, and percentage changes
- **Recent Data Focus**: Highlights most recent price movements
- **Time Range Display**: Clear indication of data coverage
- **Null Handling**: Graceful handling of missing or empty data

**Benefits**:

- Technical analysis and charting capabilities
- Trend identification for trading decisions
- Historical performance evaluation
- Price volatility assessment
- Market timing analysis
- Integration with trading algorithms

### GET_ORDER_BOOK

Retrieves order book summary (bids and asks) for a specific Polymarket token.

**Triggers**: `ORDER_BOOK`, `BOOK_SUMMARY`, `GET_BOOK`, `SHOW_BOOK`, `FETCH_BOOK`, `ORDER_BOOK_SUMMARY`, `BOOK_DATA`, `BID_ASK`, `MARKET_DEPTH`, `ORDERBOOK`

**Usage Examples**:

- "Show order book for token 123456"
- "Get order book summary for 789012"
- "ORDER_BOOK 345678"
- "What's the bid/ask spread for this token?"

**Required Parameter**:

- **tokenId**: The specific token ID for which to retrieve the order book (numeric string)

**Response**: Returns detailed order book information including:

- Token and market information
- Market depth statistics (bid/ask counts, total sizes)
- Best bid/ask prices and sizes
- Bid-ask spread calculation
- Top 5 bids and asks with prices and sizes

**Example Response**:

```
📖 Order Book Summary

Token Information:
• Token ID: 123456
• Market: 0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678
• Asset ID: 123456

Market Depth:
• Bid Orders: 5
• Ask Orders: 5
• Total Bid Size: 776.50
• Total Ask Size: 461.50

Best Prices:
• Best Bid: $0.65 (Size: 100.5)
• Best Ask: $0.66 (Size: 80.5)
• Spread: $0.0100

Top 5 Bids:
1. $0.65 - Size: 100.5
2. $0.64 - Size: 250.0
3. $0.63 - Size: 150.75
4. $0.62 - Size: 75.25
5. $0.61 - Size: 200.0

Top 5 Asks:
1. $0.66 - Size: 80.5
2. $0.67 - Size: 120.0
3. $0.68 - Size: 90.25
4. $0.69 - Size: 60.0
5. $0.70 - Size: 110.75
```

**TypeScript Usage**:

```typescript
import { getOrderBookSummaryAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getOrderBookSummaryAction.handler(runtime, message, state);

// Access order book data
const orderBook = result.data.orderBook; // OrderBook with bids/asks
const summary = result.data.summary; // Summary statistics
```

**Order Book Schema**:

```typescript
interface OrderBook {
  market: string; // Market condition ID
  asset_id: string; // Token ID
  bids: BookEntry[]; // Buy orders
  asks: BookEntry[]; // Sell orders
}

interface BookEntry {
  price: string; // Price level
  size: string; // Size at this price level
}
```

**Benefits**:

- Real-time market depth analysis
- Price discovery for trading decisions
- Liquidity assessment
- Spread analysis for market efficiency
- Order flow visualization

### GET_ORDER_BOOK_DEPTH

Retrieves order book depth data for one or more Polymarket tokens using bulk API calls.

**Triggers**: `ORDER_BOOK_DEPTH`, `BOOK_DEPTH`, `GET_DEPTH`, `SHOW_DEPTH`, `FETCH_DEPTH`, `ORDER_DEPTH`, `DEPTH_DATA`, `MULTIPLE_BOOKS`, `BULK_BOOKS`, `BOOKS_DEPTH`

**Usage Examples**:

- "Show order book depth for token 123456"
- "Get depth for tokens 123456, 789012"
- "ORDER_BOOK_DEPTH 345678 999999"
- "Fetch bulk order books for multiple tokens"

**Required Parameter**:

- **tokenIds**: Array of token IDs for which to retrieve order book depth (accepts single or multiple IDs)

**Response**: Returns array of order book objects with summary statistics including:

- Number of tokens requested vs found
- Active order books count
- Total bid/ask levels across all books
- Individual order book data for each token

**Example Response**:

```
📊 Order Book Depth Summary

Tokens Requested: 2
Order Books Found: 2

Token 1: `123456`
• Market: 0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678
• Bid Levels: 5
• Ask Levels: 5
• Best Bid: $0.65 (100.5)
• Best Ask: $0.66 (80.5)

Token 2: `789012`
• Market: 0x9876543210fedcba9876543210fedcba98765432109876543210fedcba98765432
• Bid Levels: 3
• Ask Levels: 4
• Best Bid: $0.45 (200.0)
• Best Ask: $0.46 (175.0)

Summary:
• Active Order Books: 2/2
• Total Bid Levels: 8
• Total Ask Levels: 9
```

**TypeScript Usage**:

```typescript
import { getOrderBookDepthAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getOrderBookDepthAction.handler(runtime, message, state);

// Access order book array and summary
const orderBooks = result.data.orderBooks; // OrderBook[]
const summary = result.data.summary; // Bulk statistics
const tokenIds = result.data.tokenIds; // Requested token IDs
```

**Order Book Depth Schema**:

```typescript
interface OrderBookDepthResponse {
  orderBooks: OrderBook[];
  tokenIds: string[];
  summary: {
    tokensRequested: number;
    orderBooksFound: number;
    activeBooks: number;
    totalBids: number;
    totalAsks: number;
  };
  timestamp: string;
}

interface OrderBook {
  market: string; // Market condition ID
  asset_id: string; // Token ID
  bids: BookEntry[]; // Buy orders (empty array if no bids)
  asks: BookEntry[]; // Sell orders (empty array if no asks)
  hash?: string; // Order book hash
  timestamp?: string; // Book generation timestamp
}
```

**Benefits**:

- Bulk data retrieval for multiple tokens
- Cross-market depth analysis
- Portfolio-level liquidity assessment
- Efficient API usage for multiple tokens
- Comparative market analysis

### GET_BEST_PRICE

Retrieves the best bid or ask price for a specific Polymarket token using the CLOB API price endpoint.

**Triggers**: `BEST_PRICE`, `GET_PRICE`, `SHOW_PRICE`, `FETCH_PRICE`, `PRICE_DATA`, `MARKET_PRICE`, `BID_PRICE`, `ASK_PRICE`, `BEST_BID`, `BEST_ASK`

**Usage Examples**:

- "Get best price for token 123456 on buy side"
- "What's the sell price for market token 789012?"
- "Show me the best bid for 456789"
- "Get the ask price for token abc123"

**Required Parameters**:

- **tokenId**: The token identifier (numeric string)
- **side**: Either "buy" or "sell" to specify which price to retrieve

**Side Mapping**:

- **"buy" side**: Returns the best ask price (what you pay to buy)
- **"sell" side**: Returns the best bid price (what you receive when selling)
- **"bid"** keyword maps to "sell" side
- **"ask"** keyword maps to "buy" side

**Response**: Returns the current best price for the specified side including:

- Formatted price in USD
- Percentage representation (0-100%)
- Side information and explanation
- Token ID and timestamp

**Example Response**:

```
💰 Best Ask (buy) Price for Token 123456

Price: $0.5500 (55.00%)
Side: ask (buy)
Token ID: 123456

This is the best price you would pay to buy this token.
```

**TypeScript Usage**:

```typescript
import { getBestPriceAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getBestPriceAction.handler(runtime, message, state);

// Access price data
const price = result.data.price; // Raw price string
const formattedPrice = result.data.formattedPrice; // Formatted to 4 decimals
const percentagePrice = result.data.percentagePrice; // Percentage representation
const tokenId = result.data.tokenId; // Token ID
const side = result.data.side; // buy/sell side
```

**Price Response Schema**:

```typescript
interface BestPriceResponse {
  tokenId: string;
  side: 'buy' | 'sell';
  price: string; // Raw price from API
  formattedPrice: string; // Price formatted to 4 decimals
  percentagePrice: string; // Price as percentage (2 decimals)
  timestamp: string; // ISO timestamp
}
```

**Benefits**:

- Real-time price discovery for individual tokens
- Quick price checks for trading decisions
- Support for both buy and sell side pricing
- Clear price formatting for easy interpretation
- Efficient single-token price retrieval

**Error Handling**:

- Validates token ID and side parameters
- Handles missing or invalid price data
- Provides clear error messages for troubleshooting
- Fallback regex extraction when LLM fails

### GET_MIDPOINT_PRICE

Retrieves the midpoint price (halfway between best bid and best ask) for a specific Polymarket token using the CLOB API midpoint endpoint.

**Triggers**: `MIDPOINT_PRICE`, `GET_MIDPOINT`, `SHOW_MIDPOINT`, `FETCH_MIDPOINT`, `MIDPOINT_DATA`, `MARKET_MIDPOINT`, `MID_PRICE`, `MIDDLE_PRICE`, `GET_MID_PRICE`, `SHOW_MID_PRICE`, `FETCH_MID_PRICE`, `MIDPOINT_CHECK`, `CHECK_MIDPOINT`, `MIDPOINT_LOOKUP`, `TOKEN_MIDPOINT`, `MARKET_MID`

**Usage Examples**:

- "Get midpoint price for token 123456"
- "What's the midpoint for market token 789012?"
- "Show me the mid price for 456789"
- "Get the middle price for this token"

**Required Parameter**:

- **tokenId**: The token identifier (numeric string)

**Response**: Returns the current midpoint price including:

- Formatted price in USD
- Percentage representation (0-100%)
- Token ID and timestamp
- Explanation of what midpoint price represents

**Example Response**:

```
🎯 Midpoint Price for Token 123456

Midpoint Price: $0.5500 (55.00%)
Token ID: 123456

The midpoint price represents the halfway point between the best bid and best ask prices, providing a fair market value estimate for this prediction market token.
```

**TypeScript Usage**:

```typescript
import { getMidpointPriceAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getMidpointPriceAction.handler(runtime, message, state);

// Access midpoint price data
const midpoint = result.data.midpoint; // Raw midpoint string
const formattedPrice = result.data.formattedPrice; // Formatted to 4 decimals
const percentagePrice = result.data.percentagePrice; // Percentage representation
const tokenId = result.data.tokenId; // Token ID
```

**Midpoint Price Response Schema**:

```typescript
interface MidpointPriceResponse {
  tokenId: string;
  midpoint: string; // Raw midpoint price from API
  formattedPrice: string; // Price formatted to 4 decimals
  percentagePrice: string; // Price as percentage (2 decimals)
  timestamp: string; // ISO timestamp
}
```

**Benefits**:

- Fair market value estimation for tokens
- Single price point for valuation
- Ideal for portfolio valuation
- Quick price reference without bid/ask spread
- Efficient single-token price discovery

**Use Cases**:

- Portfolio valuation and reporting
- Market analysis and comparison
- Fair value pricing for positions
- Quick price checks for decision making
- Historical price tracking

**Error Handling**:

- Validates token ID parameter
- Handles missing or invalid midpoint data
- Provides clear error messages for troubleshooting
- Fallback regex extraction when LLM fails

### GET_SPREAD

Retrieves the spread (difference between best ask and best bid) for a specific Polymarket token using the CLOB API spread endpoint.

**Triggers**: `SPREAD`, `GET_SPREAD`, `SHOW_SPREAD`, `FETCH_SPREAD`, `SPREAD_DATA`, `MARKET_SPREAD`, `BID_ASK_SPREAD`, `GET_BID_ASK_SPREAD`, `SHOW_BID_ASK_SPREAD`, `FETCH_BID_ASK_SPREAD`, `SPREAD_CHECK`, `CHECK_SPREAD`, `SPREAD_LOOKUP`, `TOKEN_SPREAD`, `MARKET_BID_ASK`, `GET_MARKET_SPREAD`, `SHOW_MARKET_SPREAD`, `FETCH_MARKET_SPREAD`

**Usage Examples**:

- "Get spread for token 123456"
- "What's the bid-ask spread for market token 789012?"
- "Show me the spread for 456789"
- "Get the market spread for this token"

**Required Parameter**:

- **tokenId**: The token identifier (numeric string)

**Response**: Returns the current spread including:

- Raw spread value
- Formatted spread (4 decimal places)
- Percentage representation (0-100%)
- Token ID and timestamp
- Explanation of what spread represents

**Example Response**:

```
✅ Spread for Token 123456

📊 Spread: 0.0450 (4.50%)

Details:
• Token ID: 123456
• Spread Value: 0.0450
• Percentage: 4.50%

The spread represents the difference between the best ask and best bid prices.
```

**TypeScript Usage**:

```typescript
import { getSpreadAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getSpreadAction.handler(runtime, message, state);

// Access spread data
const spread = result.data.spread; // Raw spread string
const formattedSpread = result.data.formattedSpread; // Formatted to 4 decimals
const percentageSpread = result.data.percentageSpread; // Percentage representation
const tokenId = result.data.tokenId; // Token ID
```

**Spread Response Schema**:

```typescript
interface SpreadResponse {
  tokenId: string;
  spread: string; // Raw spread value from API
  formattedSpread: string; // Spread formatted to 4 decimals
  percentageSpread: string; // Spread as percentage (2 decimals)
  timestamp: string; // ISO timestamp
}
```

**Benefits**:

- Market liquidity assessment
- Trading cost estimation
- Order placement strategy
- Market efficiency measurement
- Spread monitoring and analysis

**Use Cases**:

- Evaluating market liquidity before trading
- Comparing spread across different tokens
- Monitoring market efficiency
- Determining optimal order placement timing
- Spread analysis for market making

**Error Handling**:

- Validates token ID parameter
- Handles missing or invalid spread data
- Provides clear error messages for troubleshooting
- Fallback regex extraction when LLM fails

### CREATE_API_KEY

Creates API key credentials for Polymarket CLOB authentication. This action generates the L2 authentication required for order posting and other authenticated operations.

**Triggers**: `CREATE_API_KEY`, `CREATE_POLYMARKET_API_KEY`, `GENERATE_API_CREDENTIALS`, `CREATE_CLOB_CREDENTIALS`, `SETUP_API_ACCESS`

**Usage Examples**:

- "Create API key for Polymarket trading"
- "Generate new CLOB API credentials"
- "Setup API access for order posting"
- "I need API credentials for trading"

**Required Environment Variables**:

- **WALLET_PRIVATE_KEY** or **PRIVATE_KEY** or **POLYMARKET_PRIVATE_KEY**: Private key for wallet signature

**No Parameters Required**: API key generation is based on wallet signature

**Response**: Returns newly created API credentials including:

- API Key ID (for authentication headers)
- Secret (truncated for security in response)
- Passphrase (truncated for security in response)
- Creation timestamp
- Security warnings and next steps

**Example Response**:

```
✅ API Key Created Successfully

Credentials Generated:
• API Key: 12345678-1234-5678-9abc-123456789012
• Secret: abcd1234... (truncated for security)
• Passphrase: xyz78901... (truncated for security)
• Created: 2024-01-15T10:30:00.000Z

⚠️ Security Notice:
- Store these credentials securely
- Never share your secret or passphrase
- These credentials enable L2 authentication for order posting

Next Steps:
You can now place orders on Polymarket. The system will automatically use these credentials for authenticated operations.
```

**TypeScript Usage**:

```typescript
import { createApiKeyAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await createApiKeyAction.handler(runtime, message, state);

// Access API key data
const apiKey = result.data.apiKey.id; // API key ID
const created = result.data.apiKey.created_at; // Creation timestamp
```

**API Key Response Schema**:

```typescript
interface ApiKeyResponse {
  id: string; // API key identifier
  secret: string; // API secret (store securely)
  passphrase: string; // API passphrase (store securely)
  created_at?: string; // Creation timestamp
}
```

**Security Considerations**:

- API credentials are generated using your wallet's private key signature
- Store credentials securely in environment variables or secure storage
- Never share or log the full secret or passphrase
- Credentials enable authenticated trading operations
- Use HTTPS connections when transmitting credentials

**Use Cases**:

- Setting up trading capabilities for the first time
- Rotating API credentials for security
- Enabling order placement and cancellation
- Accessing authenticated market data endpoints
- Preparing for automated trading strategies

**What API Credentials Enable**:

- **Order Placement**: Create buy/sell orders on markets
- **Order Management**: Cancel or modify existing orders
- **Account Operations**: View balances and positions
- **Authenticated Endpoints**: Access private user data
- **Rate Limit Benefits**: Higher rate limits for authenticated users

**Error Handling**:

- Validates private key availability in environment
- Handles wallet signature failures
- Provides clear error messages for troubleshooting
- Network connectivity and API error handling

**Integration with Order Placement**:

Once API credentials are created, they are automatically used by other trading actions like PLACE_ORDER for authenticated operations.

### PLACE_ORDER

Creates and places both limit and market orders on Polymarket prediction markets. This action uses the official Polymarket ClobClient to create signed orders and submit them to the CLOB (Central Limit Order Book).

**Triggers**: `PLACE_ORDER`, `CREATE_ORDER`, `BUY_TOKEN`, `SELL_TOKEN`, `LIMIT_ORDER`, `MARKET_ORDER`, `TRADE`, `ORDER`, `BUY`, `SELL`, `PURCHASE`, `PLACE_BUY`, `PLACE_SELL`, `CREATE_BUY_ORDER`, `CREATE_SELL_ORDER`, `SUBMIT_ORDER`, `EXECUTE_ORDER`, `MAKE_ORDER`, `PLACE_TRADE`

**Usage Examples**:

- "Buy 100 shares of token 123456 at $0.50 limit order"
- "Sell 50 tokens of 789012 at $0.75"
- "Place market order to buy 25 tokens of 456789"
- "Create a GTC order to buy 200 shares at 0.60 for market 111222"
- "Submit FOK sell order for 75 shares at $0.45"

**Required Parameters**:

- **tokenId**: The specific token ID for the prediction market outcome (numeric string)
- **side**: Order side - `BUY` or `SELL`
- **price**: Price per share (0.0-1.0 for prediction markets, or percentage like 50 for 50%)
- **size**: Number of shares to buy/sell

**Optional Parameters**:

- **orderType**: Order type - `GTC` (limit), `FOK` (market), `GTD`, `FAK` (default: `GTC`)
- **feeRateBps**: Fee rate in basis points (default: `0`)

**Order Types**:

- **GTC (Good Till Cancelled)**: Limit order that stays active until filled or cancelled
- **FOK (Fill Or Kill)**: Market order that executes immediately or fails completely
- **GTD (Good Till Date)**: Order with expiration date
- **FAK (Fill And Kill)**: Partial fill allowed, remainder cancelled

**Prerequisites**:

1. **API Credentials**: Must have created API keys using CREATE_API_KEY action
2. **Environment Variables**: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE must be set
3. **Private Key**: POLYMARKET_PRIVATE_KEY for order signing
4. **Active Market**: Token ID must correspond to an active, tradeable market

**Example Responses**:

**Successful Limit Order**:

```
✅ Order Placed Successfully

Order Details:
• Type: limit buy order
• Token ID: 123456
• Side: BUY
• Price: $0.5000 (50.00%)
• Size: 100 shares
• Total Value: $50.0000
• Fee Rate: 0 bps

Order Response:
• Order ID: order_abc123
• Status: unmatched
• Transaction Hash(es): 0xabcdef123456

📋 Your order has been placed and is waiting to be matched.
```

**Successful Market Order**:

```
✅ Order Placed Successfully

Order Details:
• Type: market sell order
• Token ID: 789012
• Side: SELL
• Price: $0.7500 (75.00%)
• Size: 50 shares
• Total Value: $37.5000
• Fee Rate: 10 bps

Order Response:
• Order ID: order_xyz789
• Status: matched
• Transaction Hash(es): 0x123456abcdef

🎉 Your order was immediately matched and executed!
```

**TypeScript Usage**:

```typescript
import { placeOrderAction } from '@elizaos/plugin-polymarket';

// Place a limit buy order
const limitOrder = await placeOrderAction.handler(
  runtime,
  {
    content: { text: 'Buy 100 shares of token 123456 at $0.50 limit order' },
  },
  state
);

// Place a market sell order
const marketOrder = await placeOrderAction.handler(
  runtime,
  {
    content: { text: 'Place market order to sell 50 tokens of 789012' },
  },
  state
);

// Access order response data
const orderDetails = limitOrder.data.orderDetails;
const orderResponse = limitOrder.data.orderResponse;
const success = limitOrder.data.success;
```

**Order Response Schema**:

```typescript
interface PlaceOrderResponse {
  success: boolean;
  orderDetails: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    orderType: string;
    feeRateBps: string;
    totalValue: string;
  };
  orderResponse: {
    success: boolean;
    orderId?: string;
    status?: 'matched' | 'delayed' | 'unmatched';
    orderHashes?: string[];
    errorMsg?: string;
  };
  timestamp: string;
}
```

**Parameter Extraction**:

The action uses intelligent parameter extraction with two methods:

1. **LLM Extraction**: Uses AI to understand natural language requests
2. **Regex Fallback**: Pattern matching for structured requests

**Supported Input Formats**:

```typescript
// Natural language
'I want to buy 100 shares of token 123456 at $0.50 as a limit order';

// Structured format
'Buy 100 tokens of 123456 at price $0.50';

// Market orders
'Place market order to sell 50 shares of token 789012';

// With order type
'Create GTC order to buy 25 shares at 0.75 for market 456789';
```

**Price Handling**:

- **Decimal format**: 0.50 (50% probability)
- **Percentage format**: 50 (automatically converted to 0.50)
- **Dollar format**: $0.50 (parsed as 0.50)

**Error Handling**:

```typescript
// Configuration errors
'❌ CLOB_API_URL is required in configuration';

// Parameter errors
'❌ Please provide valid order parameters: token ID, price, and size';

// Market errors
'❌ Invalid market data: The market may not exist or be inactive';

// Order placement errors
'❌ Failed to submit order: Insufficient balance';
```

**Security Considerations**:

- Orders are cryptographically signed using your private key
- API credentials are required for order submission
- All orders are subject to Polymarket's risk management
- Private keys never leave your local environment

**Use Cases**:

- **Limit Orders**: Set specific price targets and wait for fills
- **Market Orders**: Execute immediately at current market prices
- **Automated Trading**: Integrate with trading strategies and bots
- **Portfolio Management**: Rebalance positions across markets
- **Arbitrage**: Take advantage of price discrepancies

**Best Practices**:

1. **Start Small**: Test with small order sizes first
2. **Check Markets**: Verify token IDs correspond to active markets
3. **Monitor Orders**: Track order status and fills
4. **Risk Management**: Set appropriate position sizes
5. **Fee Awareness**: Consider fee rates in your trading strategy

**Integration Examples**:

```typescript
// Combined with market data
const markets = await getClobMarkets.handler(runtime, message, state);
const tokenId = markets.data.markets[0].tokens[0].token_id;

const order = await placeOrderAction.handler(
  runtime,
  {
    content: { text: `Buy 100 shares of token ${tokenId} at $0.60` },
  },
  state
);

// Order management workflow
const orderBook = await getOrderBookSummary.handler(
  runtime,
  {
    content: { text: `Show order book for token ${tokenId}` },
  },
  state
);

const bestPrice = orderBook.data.orderBook.bids[0]?.price;
if (bestPrice) {
  await placeOrderAction.handler(
    runtime,
    {
      content: { text: `Buy 50 shares of token ${tokenId} at $${bestPrice}` },
    },
    state
  );
}
```

**Troubleshooting**:

| Issue                       | Solution                                         |
| --------------------------- | ------------------------------------------------ |
| "CLOB_API_URL required"     | Set CLOB_API_URL environment variable            |
| "API credentials not found" | Create API keys using CREATE_API_KEY action      |
| "Invalid token ID"          | Verify token ID exists and market is active      |
| "Insufficient balance"      | Check account balance and allowances             |
| "Order creation failed"     | Verify market is active and parameters are valid |

**Rate Limits**:

- Follows Polymarket's standard rate limiting
- Failed orders don't count against rate limits
- Consider delays between rapid order submissions

### DELETE_API_KEY

Deletes the API key currently configured in your environment variables from Polymarket. This action is irreversible and targets the key specified by `CLOB_API_KEY`, `CLOB_API_SECRET`, and `CLOB_API_PASSPHRASE`.

**Triggers**: `DELETE_API_KEY`, `REMOVE_API_KEY`, `DELETE_CONFIGURED_API_KEY`, `REMOVE_CONFIGURED_API_KEY`, `ERASE_API_KEY`, `REVOKE_API_KEY`

**Usage Examples**:

- "Delete my configured Polymarket API key"
- "Remove API key abc123def456" (Note: The specified ID is for confirmation only)
- "Erase my configured API key"

**Important Note**:
This action will **always** delete the API key that is currently configured in your environment via the `CLOB_API_KEY`, `CLOB_API_SECRET`, and `CLOB_API_PASSPHRASE` variables. If you provide an API key ID in your message, it's used for confirmation purposes only - the action will still delete the configured key.

**Required Environment Variables**:

- `CLOB_API_URL`: Polymarket CLOB endpoint
- `CLOB_API_KEY`: The API key to be deleted
- `CLOB_API_SECRET` (or `CLOB_SECRET`): The secret for the API key
- `CLOB_API_PASSPHRASE` (or `CLOB_PASS_PHRASE`): The passphrase for the API key
- `WALLET_PRIVATE_KEY` (or `PRIVATE_KEY` / `POLYMARKET_PRIVATE_KEY`): For signing the deletion request

**Example Success Response**:

```json
{
  "text": "✅ Successfully deleted API Key: your-configured-api-key-id\n\nThe API key has been permanently removed from Polymarket. You will need to create new API credentials to continue using authenticated endpoints.",
  "data": {
    "success": true,
    "deletedKeyId": "your-configured-api-key-id",
    "message": "API Key your-configured-api-key-id was successfully deleted from Polymarket."
  }
}
```

**Example Error Response**:

```json
{
  "text": "❌ Failed to delete API Key your-configured-api-key-id: API Key your-configured-api-key-id not found or invalid. It may have already been deleted.\n\nPossible causes:\n• API key has already been deleted\n• Invalid API credentials\n• Network connectivity issues\n• Polymarket API is temporarily unavailable",
  "data": {
    "success": false,
    "deletedKeyId": "your-configured-api-key-id",
    "message": "API Key your-configured-api-key-id not found or invalid. It may have already been deleted.",
    "error": "API key not found"
  }
}
```

**TypeScript Usage**:

```typescript
import { deleteApiKeyAction, DeleteApiKeyPayload, DeleteApiKeyResponseData } from '@elizaos/plugin-polymarket';
import { IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';

// Example usage
const runtime: IAgentRuntime = /* your runtime */;
const message: Memory = {
  content: { text: 'Delete my configured API key' }
} as Memory;
const state: State = {} as State;

const callback: HandlerCallback = (response) => {
  const data = response.data as DeleteApiKeyResponseData;
  if (data.success) {
    console.log(`API key ${data.deletedKeyId} was successfully deleted`);
  } else {
    console.error(`Failed to delete API key: ${data.error}`);
  }
};

// Call the action
await deleteApiKeyAction.handler(runtime, message, state, {}, callback);
```

**Response Data Schema**:

```typescript
interface DeleteApiKeyResponseData {
  success: boolean; // True if deletion was successful
  message?: string; // Descriptive message about the outcome
  deletedKeyId?: string; // ID of the API key that was deleted
  error?: string; // Error message if success is false
}
```

**Security Considerations**:

- API credentials are generated using your wallet's private key signature
- Store credentials securely in environment variables or secure storage
- Never share or log the full secret or passphrase
- Credentials enable authenticated trading operations
- Use HTTPS connections when transmitting credentials

**Use Cases**:

- Setting up trading capabilities for the first time
- Rotating API credentials for security
- Enabling order placement and cancellation
- Accessing authenticated market data endpoints
- Preparing for automated trading strategies

**What API Credentials Enable**:

- **Order Placement**: Create buy/sell orders on markets
- **Order Management**: Cancel or modify existing orders
- **Account Operations**: View balances and positions
- **Authenticated Endpoints**: Access private user data
- **Rate Limit Benefits**: Higher rate limits for authenticated users

**Error Handling**:

- Validates private key availability in environment
- Handles wallet signature failures
- Provides clear error messages for troubleshooting
- Network connectivity and API error handling

**Integration with Order Placement**:

Once API credentials are created, they are automatically used by other trading actions like PLACE_ORDER for authenticated operations.

### PLACE_TYPED_ORDER

Creates and places typed orders with explicit order type handling (GTC, FOK, GTD) on Polymarket prediction markets. This action provides more granular control over order types compared to the general PLACE_ORDER action.

**Triggers**: `PLACE_TYPED_ORDER`, `CREATE_TYPED_ORDER`, `PLACE_GTC_ORDER`, `PLACE_FOK_ORDER`, `PLACE_GTD_ORDER`, `CREATE_GTC_ORDER`, `CREATE_FOK_ORDER`, `CREATE_GTD_ORDER`, `TYPED_ORDER`, `SPECIFIC_ORDER_TYPE`, `ORDER_WITH_TYPE`, `LIMIT_ORDER_TYPED`, `MARKET_ORDER_TYPED`, `TIMED_ORDER`, `EXPIRING_ORDER`

**Usage Examples**:

- "Place GTC buy order for 100 shares of token 123456 at $0.50"
- "Create FOK sell order for 50 tokens 789012 at price 0.75"
- "Place GTD order to buy 25 shares of 456789 at $0.60 expiring in 2 hours"
- "Create GTC limit order to sell 200 shares at $0.45"

**Required Parameters**:

- **tokenId**: The specific token ID for the prediction market outcome (numeric string)
- **side**: Order side - `BUY` or `SELL`
- **price**: Price per share (0.01-0.99 for prediction markets)
- **size**: Number of shares to buy/sell
- **orderType**: Order type - `GTC`, `FOK`, or `GTD`

**Optional Parameters**:

- **expiration**: Unix timestamp for GTD orders (auto-generated if not provided)
- **feeRateBps**: Fee rate in basis points (default: `0`)

**Order Types Explained**:

| Order Type | Full Name           | Description                                                                 | Use Case                                                            |
| ---------- | ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **GTC**    | Good Till Cancelled | Limit order that stays active until filled or manually cancelled            | Setting specific price targets and waiting for market to reach them |
| **FOK**    | Fill Or Kill        | Market order that must execute immediately in full or be cancelled entirely | Immediate execution when you need to enter/exit quickly             |
| **GTD**    | Good Till Date      | Order with automatic expiration at a specified timestamp                    | Time-sensitive strategies with automatic cleanup                    |

**Prerequisites**:

1. **API Credentials**: Must have created API keys using CREATE_API_KEY action
2. **Environment Variables**: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE must be set
3. **Private Key**: POLYMARKET_PRIVATE_KEY for order signing
4. **Active Market**: Token ID must correspond to an active, tradeable market

**Example Responses**:

**Successful GTC Order**:

```
✅ **GTC Order Placed Successfully**

**Order Details:**
• **Type**: Good Till Cancelled (limit order) buy
• **Token ID**: 123456
• **Side**: BUY
• **Price**: $0.5000 (50.00%)
• **Size**: 100 shares
• **Total Value**: $50.0000
• **Fee Rate**: 0 bps

**Order Response:**
• **Order ID**: order_abc123
• **Status**: unmatched
• **Transaction Hash(es)**: 0xabcdef123456

📋 Your order has been placed and is waiting to be matched.
```

**Successful FOK Order**:

```
✅ **FOK Order Placed Successfully**

**Order Details:**
• **Type**: Fill Or Kill (market order) sell
• **Token ID**: 789012
• **Side**: SELL
• **Price**: $0.7500 (75.00%)
• **Size**: 50 shares
• **Total Value**: $37.5000
• **Fee Rate**: 0 bps

**Order Response:**
• **Order ID**: order_xyz789
• **Status**: matched
• **Transaction Hash(es)**: 0x123456abcdef

🎉 Your order was immediately matched and executed!
```

**Successful GTD Order**:

```
✅ **GTD Order Placed Successfully**

**Order Details:**
• **Type**: Good Till Date (expiring order) buy
• **Token ID**: 456789
• **Side**: BUY
• **Price**: $0.6000 (60.00%)
• **Size**: 25 shares
• **Total Value**: $15.0000
• **Fee Rate**: 0 bps
• **Expiration**: 12/25/2024, 3:30:00 PM

**Order Response:**
• **Order ID**: order_gtd456
• **Status**: unmatched
• **Transaction Hash(es)**: 0x789abcdef123

📋 Your order has been placed and will automatically cancel if not filled by the expiration time.
```

**TypeScript Usage**:

```typescript
import { placeTypedOrderAction, PlaceTypedOrderResponseData } from '@elizaos/plugin-polymarket';

// Place a GTC limit order
const gtcOrder = await placeTypedOrderAction.handler(
  runtime,
  {
    content: { text: 'Place GTC buy order for 100 shares of token 123456 at $0.50' },
  },
  state
);

// Place a FOK market order
const fokOrder = await placeTypedOrderAction.handler(
  runtime,
  {
    content: { text: 'Create FOK sell order for 50 tokens 789012 at price 0.75' },
  },
  state
);

// Place a GTD order with expiration
const gtdOrder = await placeTypedOrderAction.handler(
  runtime,
  {
    content: { text: 'Place GTD order to buy 25 shares of 456789 at $0.60 expiring in 2 hours' },
  },
  state
);

// Access order response data
const orderDetails = gtcOrder.data.orderDetails;
const orderResponse = gtcOrder.data.orderResponse;
const success = gtcOrder.data.success;
```

**Response Schema**:

```typescript
interface PlaceTypedOrderResponseData {
  success: boolean;
  orderDetails: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    orderType: string;
    expiration?: number; // Unix timestamp for GTD orders
    feeRateBps: string;
    totalValue: string;
  };
  orderResponse: {
    success: boolean;
    orderId?: string;
    status?: 'matched' | 'delayed' | 'unmatched';
    orderHashes?: string[];
    errorMsg?: string;
  };
  timestamp: string;
}

interface PlaceTypedOrderPayload {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  orderType: 'GTC' | 'FOK' | 'GTD';
  expiration?: number; // Unix timestamp for GTD orders
  feeRateBps?: string;
}
```

**Parameter Extraction**:

The action uses intelligent parameter extraction with two methods:

1. **LLM Extraction**: Uses AI to understand natural language requests
2. **Regex Fallback**: Pattern matching for structured requests

**Supported Input Formats**:

```typescript
// Natural language with order type
'Place GTC buy order for 100 shares of token 123456 at $0.50';

// Market order specification
'Create FOK sell order for 50 tokens 789012 at price 0.75';

// GTD with expiration
'Place GTD order to buy 25 shares of 456789 at $0.60 expiring in 2 hours';

// Structured format
'place GTC 100 123456 at 0.50';
```

**GTD Expiration Handling**:

- **Natural Language**: "expiring in 2 hours", "expires in 30 minutes"
- **Auto-Default**: If GTD order doesn't specify expiration, defaults to 1 hour
- **Unix Timestamp**: Direct timestamp support for programmatic use
- **Time Parsing**: Supports hours and minutes in natural language

**Error Handling**:

```typescript
// Parameter validation errors
'❌ Please provide valid typed order parameters: token ID, side, price, size, and order type';

// Order type validation
'❌ Invalid order type: INVALID. Must be GTC, FOK, or GTD';

// Price validation
'❌ Price 1.5 is outside valid range (0.01-0.99) for prediction markets';

// Market errors
'❌ Invalid market data: The market may not exist or be inactive';

// Insufficient balance
'❌ Insufficient balance to place this order. Please check your account balance';
```

**Key Differences from PLACE_ORDER**:

| Feature              | PLACE_ORDER                | PLACE_TYPED_ORDER             |
| -------------------- | -------------------------- | ----------------------------- |
| **Order Types**      | Generic with optional type | Explicit GTC/FOK/GTD handling |
| **Expiration**       | Limited support            | Full GTD expiration control   |
| **Type Validation**  | Basic                      | Comprehensive type checking   |
| **Natural Language** | General                    | Type-specific parsing         |
| **Use Case**         | General trading            | Specific order strategies     |

**Use Cases and Strategies**:

**GTC Orders (Good Till Cancelled)**:

- Setting price targets and waiting for market movement
- Dollar-cost averaging strategies
- Long-term position building
- Taking advantage of market volatility

**FOK Orders (Fill Or Kill)**:

- Quick market entry/exit
- Arbitrage opportunities
- Large orders that need immediate full execution
- Time-sensitive trading strategies

**GTD Orders (Good Till Date)**:

- Event-driven trading with automatic cleanup
- Short-term strategies with defined time limits
- Reducing manual order management
- Preventing stale orders in fast-moving markets

**Best Practices**:

1. **Order Type Selection**:

   - Use GTC for patient, price-sensitive strategies
   - Use FOK for immediate execution needs
   - Use GTD for time-bounded strategies

2. **GTD Expiration Guidelines**:

   - Set realistic expiration times based on market volatility
   - Consider market hours and expected volume
   - Allow buffer time for potential fills

3. **Price Setting**:

   - GTC: Set competitive but patient prices
   - FOK: Use current market prices for immediate execution
   - GTD: Balance competitive pricing with time constraints

4. **Risk Management**:
   - Monitor GTC orders regularly to avoid stale prices
   - Use FOK for large orders to avoid partial fills
   - Set appropriate GTD expiration to limit exposure time

**Integration Examples**:

```typescript
// Strategy: Time-based arbitrage with GTD
const arbitrageOrder = await placeTypedOrderAction.handler(
  runtime,
  {
    content: {
      text: 'Place GTD buy order for 500 shares of token 123456 at $0.48 expiring in 30 minutes',
    },
  },
  state
);

// Strategy: Quick exit with FOK
const exitOrder = await placeTypedOrderAction.handler(
  runtime,
  {
    content: { text: 'Create FOK sell order for 1000 tokens 789012 at current market price' },
  },
  state
);

// Strategy: Patient accumulation with GTC
const accumulationOrder = await placeTypedOrderAction.handler(
  runtime,
  {
    content: { text: 'Place GTC buy order for 200 shares of token 456789 at $0.52' },
  },
  state
);
```

**Troubleshooting**:

| Issue                       | Solution                                                |
| --------------------------- | ------------------------------------------------------- |
| "Invalid order type"        | Use only GTC, FOK, or GTD                               |
| "GTD expiration required"   | Specify expiration time or let system default to 1 hour |
| "Price outside valid range" | Use prices between 0.01 and 0.99 for prediction markets |
| "Order creation failed"     | Check market is active and parameters are valid         |
| "Insufficient balance"      | Verify account has enough funds for the order           |

### CANCEL_ALL_ORDERS

Cancels all open orders for the authenticated user across all Polymarket markets. This action provides a quick way to stop all trading activity and clear all pending orders.

**Triggers**: `CANCEL_ALL_ORDERS`, `CANCEL_ALL`, `CANCEL_ORDERS`, `CANCEL_ALL_OPEN_ORDERS`, `CLOSE_ALL_ORDERS`, `STOP_ALL_ORDERS`, `CANCEL_EVERYTHING`, `CANCEL_ALL_TRADES`, `CANCEL_ALL_POSITIONS`, `STOP_ALL_TRADING`, `CLOSE_ALL_POSITIONS`, `CANCEL_OPEN_ORDERS`, `CANCEL_PENDING_ORDERS`, `CLEAR_ALL_ORDERS`, `REMOVE_ALL_ORDERS`

**Usage Examples**:

- "Cancel all my open orders"
- "Stop all my trading and cancel everything"
- "Clear all pending orders"
- "CANCEL_ALL_ORDERS"

**Prerequisites**:

1. **API Credentials**: Must have created API keys using CREATE_API_KEY action
2. **Environment Variables**: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE must be set
3. **Private Key**: POLYMARKET_PRIVATE_KEY for signing cancellation requests

**No Parameters Required**: This action automatically cancels all open orders for your account

**Example Successful Response**:

```
✅ **All Orders Cancelled Successfully**

**Cancellation Summary:**
• **Orders Cancelled**: 5
• **Status**: Complete
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Cancelled Order IDs:**
1. `order-abc123def456`
2. `order-789xyz012abc`
3. `order-def456ghi789`
4. `order-mno123pqr456`
5. `order-stu789vwx012`

**Result**: Successfully cancelled 5 open orders

**⚠️ Important Note:**
All your pending orders across all markets have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.
```

**Example No Orders Response**:

```
✅ **All Orders Cancelled Successfully**

**Cancellation Summary:**
• **Orders Cancelled**: All open orders
• **Status**: Complete
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Result**: No open orders found to cancel

**⚠️ Important Note:**
All your pending orders across all markets have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.
```

**TypeScript Usage**:

```typescript
import { cancelAllOrdersAction, CancelAllOrdersResponseData } from '@elizaos/plugin-polymarket';

// Cancel all open orders
const result = await cancelAllOrdersAction.handler(
  runtime,
  {
    content: { text: 'Cancel all my open orders' },
  },
  state
);

// Access cancellation response data
const success = result.data.success; // boolean
const cancelledCount = result.data.cancelledOrdersCount; // number
const cancelledOrders = result.data.cancelledOrders; // string[]
const message = result.data.message; // string
const timestamp = result.data.timestamp; // string

// Handle the response
if (success) {
  console.log(`Successfully cancelled ${cancelledCount} orders`);
  console.log('Cancelled order IDs:', cancelledOrders);
} else {
  console.error('Failed to cancel orders:', result.data.error);
}
```

**Response Schema**:

```typescript
interface CancelAllOrdersResponseData {
  success: boolean; // True if cancellation was successful
  cancelledOrdersCount: number; // Number of orders that were cancelled
  cancelledOrders: string[]; // Array of cancelled order IDs
  message: string; // Descriptive message about the result
  timestamp: string; // ISO timestamp of the operation
  error?: string; // Error message if success is false
}
```

**Response Handling**:

The action intelligently handles different response formats from the Polymarket CLOB API:

1. **Array Response**: When API returns array of cancelled order IDs
2. **Object Response**: When API returns object with success status and order details
3. **Simple Response**: When API returns basic success indicator
4. **Empty Response**: When no orders are found to cancel

**Key Features**:

- **Bulk Cancellation**: Cancels all orders in a single API call
- **Cross-Market**: Works across all markets where you have open orders
- **Comprehensive Logging**: Returns detailed information about cancelled orders
- **Error Handling**: Graceful handling of various error scenarios
- **Order Tracking**: Provides list of cancelled order IDs for reference

**Use Cases**:

**Emergency Stop**:

- Quickly halt all trading activity
- Respond to market volatility or news events
- Stop automated trading strategies immediately

**Portfolio Management**:

- Clean slate before implementing new strategy
- End of trading session cleanup
- Risk management during uncertain periods

**Strategy Changes**:

- Clear existing orders before strategy adjustment
- Switch between different trading approaches
- Rebalance order book positioning

**Maintenance**:

- Prepare for system maintenance or updates
- Clean up stale or outdated orders
- Simplify order management workflow

**Error Handling**:

```typescript
// Authentication errors
'❌ Authentication failed. Please check your API credentials.';

// Network errors
'❌ Network connectivity issues. Please try again in a moment.';

// Rate limiting
'❌ Rate limit exceeded. Please wait before trying again.';

// No orders to cancel
'❌ No open orders found to cancel.';

// General API errors
'❌ An unexpected error occurred while cancelling orders.';
```

**Important Considerations**:

**Irreversible Action**:

- Once orders are cancelled, they cannot be uncancelled or restored
- You must place a new order if you want to re-enter the position
- Executed portions of partially filled orders remain valid

**Market Impact**:

- Large cancellations may affect market liquidity temporarily
- Consider market conditions before bulk cancellation
- Some orders may fill during the cancellation process

**Timing**:

- Cancellation requests are processed immediately
- Network latency may affect exact timing
- Some orders might execute before cancellation completes

**Best Practices**:

1. **Confirmation**: Double-check you want to cancel ALL orders
2. **Timing**: Consider market hours and activity levels
3. **Follow-up**: Verify cancellation success and remaining positions
4. **Documentation**: Keep records of cancelled orders for analysis
5. **Strategy**: Have a plan for recreating desired orders if needed

**Integration Examples**:

```typescript
// Emergency stop with confirmation
const orderBook = await getActiveOrdersAction.handler(
  runtime,
  {
    content: { text: 'Show my active orders' },
  },
  state
);

if (orderBook.data.orders.length > 0) {
  console.log(`Found ${orderBook.data.orders.length} active orders`);

  const cancelResult = await cancelAllOrdersAction.handler(
    runtime,
    {
      content: { text: 'Cancel all orders immediately' },
    },
    state
  );

  console.log(`Cancellation result: ${cancelResult.data.message}`);
}

// Scheduled cleanup
const cleanup = async () => {
  try {
    const result = await cancelAllOrdersAction.handler(
      runtime,
      {
        content: { text: 'End of day cleanup - cancel all orders' },
      },
      state
    );

    if (result.data.success) {
      console.log(`Daily cleanup: cancelled ${result.data.cancelledOrdersCount} orders`);
    }
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
};

// Strategy rotation
const rotateStrategy = async () => {
  // Step 1: Cancel all existing orders
  await cancelAllOrdersAction.handler(
    runtime,
    {
      content: { text: 'Clear all orders for strategy change' },
    },
    state
  );

  // Step 2: Implement new strategy
  // ... new order placement logic
};
```

**Troubleshooting**:

| Issue                         | Solution                                               |
| ----------------------------- | ------------------------------------------------------ |
| "Authentication failed"       | Verify API credentials are valid and properly set      |
| "No open orders found"        | Check if you have any active orders before cancelling  |
| "Network connectivity issues" | Check internet connection and try again                |
| "Rate limit exceeded"         | Wait a moment before retrying the cancellation request |
| "Operation failed"            | Check Polymarket status and API availability           |

**Rate Limits**:

- Follows Polymarket's standard rate limiting for authenticated operations
- Failed cancellations don't count against rate limits
- Consider delays between rapid cancellation requests

**Security Notes**:

- Cancellation requests are cryptographically signed
- API credentials are required for authentication
- All operations are logged for audit purposes
- Private keys never leave your local environment

### CANCEL_ORDER

Cancels a specific order by its ID on Polymarket CLOB. This action allows precise cancellation of individual orders without affecting other pending orders.

**Triggers**: `CANCEL_ORDER`, `CANCEL_ORDER_BY_ID`, `CANCEL_SPECIFIC_ORDER`, `CANCEL_ORDER_ID`, `STOP_ORDER`, `REMOVE_ORDER`, `DELETE_ORDER`, `CANCEL_TRADE`, `STOP_TRADE`, `CLOSE_ORDER`, `ABORT_ORDER`, `REVOKE_ORDER`, `WITHDRAW_ORDER`, `KILL_ORDER`, `TERMINATE_ORDER`

**Usage Examples**:

- "Cancel order abc123def456"
- "Stop order ID 789xyz012abc"
- "Remove the order with ID order-123-456-789"
- "CANCEL_ORDER 0x1234567890abcdef"

**Required Parameter**:

- **Order ID**: The specific order identifier to cancel (must be at least 8 characters)

**Prerequisites**:

1. **API Credentials**: Must have created API keys using CREATE_API_KEY action
2. **Environment Variables**: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE must be set
3. **Private Key**: POLYMARKET_PRIVATE_KEY for signing cancellation requests
4. **Valid Order ID**: Order must exist and be in a cancellable state

**Example Successful Response**:

```
✅ **Order Cancelled Successfully**

**Cancellation Details:**
• **Order ID**: `abc123def456`
• **Status**: Cancelled
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Result**: Order abc123def456 has been successfully cancelled

**⚠️ Important Note:**
The order has been permanently cancelled and cannot be restored. Any unfilled portions of the order will no longer execute, but any already executed portions remain valid.
```

**TypeScript Usage**:

```typescript
import { cancelOrderByIdAction, CancelOrderResponseData } from '@elizaos/plugin-polymarket';

// Cancel a specific order
const result = await cancelOrderByIdAction.handler(
  runtime,
  {
    content: { text: 'Cancel order abc123def456' },
  },
  state
);

// Access cancellation response data
const success = result.data.success; // boolean
const orderId = result.data.orderId; // string
const message = result.data.message; // string
const timestamp = result.data.timestamp; // string

// Handle the response
if (success) {
  console.log(`Successfully cancelled order ${orderId}`);
} else {
  console.error('Failed to cancel order:', result.data.error);
}
```

**Response Schema**:

```typescript
interface CancelOrderResponseData {
  success: boolean; // True if cancellation was successful
  orderId: string; // The order ID that was cancelled
  message: string; // Descriptive message about the result
  timestamp: string; // ISO timestamp of the operation
  error?: string; // Error message if success is false
}

interface CancelOrderPayload {
  orderId: string; // Order ID extracted from user message
  error?: string; // Error message if extraction failed
}
```

**Parameter Extraction**:

The action uses intelligent parameter extraction with two methods:

1. **LLM Extraction**: Uses AI to understand natural language requests and extract order IDs
2. **Regex Fallback**: Pattern matching for structured requests when LLM fails

**Supported Input Formats**:

```typescript
// Natural language
'Cancel order abc123def456';
'Stop the order with ID 789xyz012abc';
'Remove order order-123-456-789';

// Direct command format
'CANCEL_ORDER abc123def456';

// Structured format
'Cancel order ID: 0x1234567890abcdef';
```

**Key Features**:

- **Precise Targeting**: Cancel only the specific order you want
- **Order ID Validation**: Ensures order ID format is valid before attempting cancellation
- **Intelligent Extraction**: Understands various ways of specifying order IDs
- **Comprehensive Error Handling**: Detailed error messages for different failure scenarios
- **Fallback Logic**: Regex pattern matching when LLM extraction fails

**Use Cases**:

**Selective Cancellation**:

- Cancel specific outdated orders while keeping others active
- Remove orders with incorrect parameters
- Cancel orders that are no longer strategically relevant

**Risk Management**:

- Quickly cancel orders that may be adversely affected by market events
- Stop orders with pricing errors before they execute
- Cancel orders in specific markets while maintaining others

**Portfolio Management**:

- Remove orders that no longer fit your strategy
- Cancel orders to free up balance for better opportunities
- Clean up specific positions without affecting the entire portfolio

**Error Handling**:

```typescript
// Order not found
'❌ Order not found. The order may have already been cancelled or filled.';

// Authentication errors
'❌ Authentication failed. Please check your API credentials.';

// Network errors
'❌ Network connectivity issues. Please try again in a moment.';

// Already cancelled
'❌ Order cannot be cancelled because it is already cancelled or fully filled.';

// Invalid order ID
'❌ Invalid order ID format. Please provide a valid order identifier.';

// Missing order ID
'❌ Please provide a valid order ID to cancel';
```

**Order ID Sources**:

You can find order IDs from:

- **Order Placement Responses**: When you place orders, the response contains the order ID
- **Active Orders List**: Use the get active orders action to see current order IDs
- **Order History**: Check past orders for their IDs
- **Trading Platform**: Order IDs are displayed in the Polymarket trading interface

**Important Considerations**:

**Order States**:

- Orders can only be cancelled if they are in an active (unfilled) state
- Partially filled orders can be cancelled (only unfilled portion is cancelled)
- Fully filled orders cannot be cancelled
- Already cancelled orders will return an error

**Timing**:

- Cancellation requests are processed immediately
- Very fast-moving markets may execute orders before cancellation completes
- Network latency can affect timing of cancellation

**Irreversibility**:

- Once cancelled, orders cannot be uncancelled or restored
- You must place a new order if you want to re-enter the position
- Executed portions of partially filled orders remain valid

**Best Practices**:

1. **Verify Order ID**: Double-check the order ID before cancelling
2. **Check Order Status**: Ensure the order still exists and is cancellable
3. **Timing Consideration**: Cancel orders before important market events
4. **Record Keeping**: Keep track of cancelled orders for analysis
5. **Confirmation**: Verify cancellation success before assuming order is cancelled

**Integration Examples**:

```typescript
// Conditional cancellation based on market changes
const checkAndCancel = async (orderId: string, priceThreshold: number) => {
  const currentPrice = await getBestPriceAction.handler(
    runtime,
    {
      content: { text: `Get best price for token ${tokenId} on buy side` },
    },
    state
  );

  if (currentPrice.data.price > priceThreshold) {
    await cancelOrderByIdAction.handler(
      runtime,
      {
        content: { text: `Cancel order ${orderId}` },
      },
      state
    );
  }
};

// Batch cancellation of specific orders
const cancelSpecificOrders = async (orderIds: string[]) => {
  for (const orderId of orderIds) {
    try {
      await cancelOrderByIdAction.handler(
        runtime,
        {
          content: { text: `Cancel order ${orderId}` },
        },
        state
      );
      console.log(`Cancelled order ${orderId}`);
    } catch (error) {
      console.error(`Failed to cancel order ${orderId}:`, error);
    }
  }
};

// Cancel and replace strategy
const cancelAndReplace = async (oldOrderId: string, newOrderParams: any) => {
  // First cancel the old order
  const cancelResult = await cancelOrderByIdAction.handler(
    runtime,
    {
      content: { text: `Cancel order ${oldOrderId}` },
    },
    state
  );

  if (cancelResult.data.success) {
    // Place new order with updated parameters
    await placeOrderAction.handler(
      runtime,
      {
        content: {
          text: `Buy ${newOrderParams.size} shares of token ${newOrderParams.tokenId} at $${newOrderParams.price}`,
        },
      },
      state
    );
  }
};
```

**Troubleshooting**:

| Issue                       | Solution                                                |
| --------------------------- | ------------------------------------------------------- |
| "Invalid order type"        | Use only GTC, FOK, or GTD                               |
| "GTD expiration required"   | Specify expiration time or let system default to 1 hour |
| "Price outside valid range" | Use prices between 0.01 and 0.99 for prediction markets |
| "Order creation failed"     | Check market is active and parameters are valid         |
| "Insufficient balance"      | Verify account has enough funds for the order           |

### CANCEL_ALL_ORDERS

Cancels all open orders for the authenticated user across all Polymarket markets. This action provides a quick way to stop all trading activity and clear all pending orders.

**Triggers**: `CANCEL_ALL_ORDERS`, `CANCEL_ALL`, `CANCEL_ORDERS`, `CANCEL_ALL_OPEN_ORDERS`, `CLOSE_ALL_ORDERS`, `STOP_ALL_ORDERS`, `CANCEL_EVERYTHING`, `CANCEL_ALL_TRADES`, `CANCEL_ALL_POSITIONS`, `STOP_ALL_TRADING`, `CLOSE_ALL_POSITIONS`, `CANCEL_OPEN_ORDERS`, `CANCEL_PENDING_ORDERS`, `CLEAR_ALL_ORDERS`, `REMOVE_ALL_ORDERS`

**Usage Examples**:

- "Cancel all my open orders"
- "Stop all my trading and cancel everything"
- "Clear all pending orders"
- "CANCEL_ALL_ORDERS"

**Prerequisites**:

1. **API Credentials**: Must have created API keys using CREATE_API_KEY action
2. **Environment Variables**: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE must be set
3. **Private Key**: POLYMARKET_PRIVATE_KEY for signing cancellation requests

**No Parameters Required**: This action automatically cancels all open orders for your account

**Example Successful Response**:

```
✅ **All Orders Cancelled Successfully**

**Cancellation Summary:**
• **Orders Cancelled**: 5
• **Status**: Complete
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Cancelled Order IDs:**
1. `order-abc123def456`
2. `order-789xyz012abc`
3. `order-def456ghi789`
4. `order-mno123pqr456`
5. `order-stu789vwx012`

**Result**: Successfully cancelled 5 open orders

**⚠️ Important Note:**
All your pending orders across all markets have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.
```

**Example No Orders Response**:

```
✅ **All Orders Cancelled Successfully**

**Cancellation Summary:**
• **Orders Cancelled**: All open orders
• **Status**: Complete
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Result**: No open orders found to cancel

**⚠️ Important Note:**
All your pending orders across all markets have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.
```

**TypeScript Usage**:

```typescript
import { cancelAllOrdersAction, CancelAllOrdersResponseData } from '@elizaos/plugin-polymarket';

// Cancel all open orders
const result = await cancelAllOrdersAction.handler(
  runtime,
  {
    content: { text: 'Cancel all my open orders' },
  },
  state
);

// Access cancellation response data
const success = result.data.success; // boolean
const cancelledCount = result.data.cancelledOrdersCount; // number
const cancelledOrders = result.data.cancelledOrders; // string[]
const message = result.data.message; // string
const timestamp = result.data.timestamp; // string

// Handle the response
if (success) {
  console.log(`Successfully cancelled ${cancelledCount} orders`);
  console.log('Cancelled order IDs:', cancelledOrders);
} else {
  console.error('Failed to cancel orders:', result.data.error);
}
```

**Response Schema**:

```typescript
interface CancelAllOrdersResponseData {
  success: boolean; // True if cancellation was successful
  cancelledOrdersCount: number; // Number of orders that were cancelled
  cancelledOrders: string[]; // Array of cancelled order IDs
  message: string; // Descriptive message about the result
  timestamp: string; // ISO timestamp of the operation
  error?: string; // Error message if success is false
}
```

**Response Handling**:

The action intelligently handles different response formats from the Polymarket CLOB API:

1. **Array Response**: When API returns array of cancelled order IDs
2. **Object Response**: When API returns object with success status and order details
3. **Simple Response**: When API returns basic success indicator
4. **Empty Response**: When no orders are found to cancel

**Key Features**:

- **Bulk Cancellation**: Cancels all orders in a single API call
- **Cross-Market**: Works across all markets where you have open orders
- **Comprehensive Logging**: Returns detailed information about cancelled orders
- **Error Handling**: Graceful handling of various error scenarios
- **Order Tracking**: Provides list of cancelled order IDs for reference

**Use Cases**:

**Emergency Stop**:

- Quickly halt all trading activity
- Respond to market volatility or news events
- Stop automated trading strategies immediately

**Portfolio Management**:

- Clean slate before implementing new strategy
- End of trading session cleanup
- Risk management during uncertain periods

**Strategy Changes**:

- Clear existing orders before strategy adjustment
- Switch between different trading approaches
- Rebalance order book positioning

**Maintenance**:

- Prepare for system maintenance or updates
- Clean up stale or outdated orders
- Simplify order management workflow

**Error Handling**:

```typescript
// Authentication errors
'❌ Authentication failed. Please check your API credentials.';

// Network errors
'❌ Network connectivity issues. Please try again in a moment.';

// Rate limiting
'❌ Rate limit exceeded. Please wait before trying again.';

// No orders to cancel
'❌ No open orders found to cancel.';

// General API errors
'❌ An unexpected error occurred while cancelling orders.';
```

**Important Considerations**:

**Irreversible Action**:

- Once orders are cancelled, they cannot be uncancelled or restored
- You must place a new order if you want to re-enter the position
- Executed portions of partially filled orders remain valid

**Market Impact**:

- Large cancellations may affect market liquidity temporarily
- Consider market conditions before bulk cancellation
- Some orders may fill during the cancellation process

**Timing**:

- Cancellation requests are processed immediately
- Network latency may affect exact timing
- Some orders might execute before cancellation completes

**Best Practices**:

1. **Confirmation**: Double-check you want to cancel ALL orders
2. **Timing**: Consider market hours and activity levels
3. **Follow-up**: Verify cancellation success and remaining positions
4. **Documentation**: Keep records of cancelled orders for analysis
5. **Strategy**: Have a plan for recreating desired orders if needed

**Integration Examples**:

```typescript
// Emergency stop with confirmation
const orderBook = await getActiveOrdersAction.handler(
  runtime,
  {
    content: { text: 'Show my active orders' },
  },
  state
);

if (orderBook.data.orders.length > 0) {
  console.log(`Found ${orderBook.data.orders.length} active orders`);

  const cancelResult = await cancelAllOrdersAction.handler(
    runtime,
    {
      content: { text: 'Cancel all orders immediately' },
    },
    state
  );

  console.log(`Cancellation result: ${cancelResult.data.message}`);
}

// Scheduled cleanup
const cleanup = async () => {
  try {
    const result = await cancelAllOrdersAction.handler(
      runtime,
      {
        content: { text: 'End of day cleanup - cancel all orders' },
      },
      state
    );

    if (result.data.success) {
      console.log(`Daily cleanup: cancelled ${result.data.cancelledOrdersCount} orders`);
    }
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
};

// Strategy rotation
const rotateStrategy = async () => {
  // Step 1: Cancel all existing orders
  await cancelAllOrdersAction.handler(
    runtime,
    {
      content: { text: 'Clear all orders for strategy change' },
    },
    state
  );

  // Step 2: Implement new strategy
  // ... new order placement logic
};
```

**Troubleshooting**:

| Issue                         | Solution                                              |
| ----------------------------- | ----------------------------------------------------- |
| "Authentication failed"       | Verify API credentials are valid and properly set     |
| "No open orders found"        | Check if you have any active orders before cancelling |
| "Network connectivity issues" | Check internet connection and try again               |
| "Rate limit exceeded"         | Wait before retrying the cancellation request         |
| "Operation failed"            | Check Polymarket status and API availability          |

**Rate Limits**:

- Follows Polymarket's standard rate limiting for authenticated operations
- Failed cancellations don't count against rate limits
- Consider delays between rapid cancellation requests

**Security Notes**:

- Cancellation requests are cryptographically signed
- API credentials are required for authentication
- All operations are logged for audit purposes
- Private keys never leave your local environment

### CANCEL_MARKET_ORDERS

Cancels all orders for a specific market and/or asset ID on Polymarket CLOB. This action provides targeted cancellation capabilities, allowing you to cancel orders for specific markets or tokens while leaving orders in other markets untouched.

**Triggers**: `CANCEL_MARKET_ORDERS`, `CANCEL_ORDERS_FOR_MARKET`, `CANCEL_MARKET_ORDER`, `CANCEL_ORDERS_IN_MARKET`, `STOP_MARKET_ORDERS`, `REMOVE_MARKET_ORDERS`, `DELETE_MARKET_ORDERS`, `CANCEL_ALL_ORDERS_FOR_MARKET`, `CLOSE_MARKET_ORDERS`, `ABORT_MARKET_ORDERS`, `CANCEL_ORDERS_BY_MARKET`, `STOP_ORDERS_FOR_MARKET`, `CLEAR_MARKET_ORDERS`, `REMOVE_ORDERS_FROM_MARKET`, `CANCEL_SPECIFIC_MARKET_ORDERS`

**Usage Examples**:

- "Cancel all orders for market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af"
- "Cancel orders for asset 52114319501245915516055106046884209969926127482827954674443846427813813222426"
- "Cancel orders in market abc123 for token 456789"
- "CANCEL_MARKET_ORDERS market=0x123abc assetId=789def"
- "Stop all orders in the Trump 2024 market"

**Required Parameters** (at least one):

- **Market ID**: The market condition identifier (typically a long hex string)
- **Asset ID**: The token/asset identifier (typically a long numeric string)

Both parameters can be provided together for more precise targeting.

**Prerequisites**:

1. **API Credentials**: Must have created API keys using CREATE_API_KEY action
2. **Environment Variables**: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE must be set
3. **Private Key**: POLYMARKET_PRIVATE_KEY for signing cancellation requests
4. **Valid Identifiers**: Market condition ID and/or asset ID must be valid

**Example Successful Response (Market ID)**:

```
✅ **Market Orders Cancelled Successfully**

**Cancellation Summary:**
**Market**: `0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af`
• **Orders Cancelled**: 3
• **Status**: Complete
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Cancelled Order IDs:**
1. `order-abc123def456`
2. `order-789xyz012abc`
3. `order-def456ghi789`

**Result**: Successfully cancelled 3 orders for the specified market

**⚠️ Important Note:**
All matching orders for the specified market/asset have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.
```

**Example Successful Response (Asset ID)**:

```
✅ **Market Orders Cancelled Successfully**

**Cancellation Summary:**
**Asset ID**: `52114319501245915516055106046884209969926127482827954674443846427813813222426`
• **Orders Cancelled**: 2
• **Status**: Complete
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Cancelled Order IDs:**
1. `order-mno123pqr456`
2. `order-stu789vwx012`

**Result**: Successfully cancelled 2 orders for the specified market

**⚠️ Important Note:**
All matching orders for the specified market/asset have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.
```

**Example No Orders Response**:

```
✅ **Market Orders Cancelled Successfully**

**Cancellation Summary:**
**Market**: `0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af`
• **Orders Cancelled**: All matching orders
• **Status**: Complete
• **Timestamp**: 2024-01-15T10:30:00.000Z

**Result**: No open orders found to cancel for the specified market

**⚠️ Important Note:**
All matching orders for the specified market/asset have been cancelled. Any partially filled orders will remain as executed, but unfilled portions have been cancelled.
```

**TypeScript Usage**:

```typescript
import {
  cancelMarketOrdersAction,
  CancelMarketOrdersResponseData,
} from '@elizaos/plugin-polymarket';

// Cancel orders for a specific market
const result = await cancelMarketOrdersAction.handler(
  runtime,
  {
    content: {
      text: 'Cancel all orders for market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
    },
  },
  state
);

// Access cancellation response data
const success = result.data.success; // boolean
const cancelledCount = result.data.cancelledOrdersCount; // number
const cancelledOrders = result.data.cancelledOrders; // string[]
const market = result.data.market; // string | undefined
const assetId = result.data.assetId; // string | undefined
const message = result.data.message; // string
const timestamp = result.data.timestamp; // string

// Handle the response
if (success) {
  console.log(`Successfully cancelled ${cancelledCount} orders`);
  console.log('Cancelled order IDs:', cancelledOrders);
  console.log('Market:', market, 'Asset ID:', assetId);
} else {
  console.error('Failed to cancel market orders:', result.data.error);
}
```

**Response Schema**:

```typescript
interface CancelMarketOrdersResponseData {
  success: boolean; // True if cancellation was successful
  cancelledOrdersCount: number; // Number of orders that were cancelled
  cancelledOrders: string[]; // Array of cancelled order IDs
  market?: string; // Market condition ID (if provided)
  assetId?: string; // Asset/token ID (if provided)
  message: string; // Descriptive message about the result
  timestamp: string; // ISO timestamp of the operation
  error?: string; // Error message if success is false
}

interface CancelMarketOrdersPayload {
  market?: string; // Market condition ID (optional)
  assetId?: string; // Asset/token ID (optional)
  error?: string; // Error message if extraction failed
}
```

**Parameter Extraction**:

The action uses intelligent parameter extraction with two methods:

1. **LLM Extraction**: Uses AI to understand natural language requests and extract market/asset IDs
2. **Regex Fallback**: Pattern matching for structured requests when LLM fails

**Supported Input Formats**:

```typescript
// Market ID only
'Cancel all orders for market 0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af';
'Stop orders in market abc123';

// Asset ID only
'Cancel orders for asset 52114319501245915516055106046884209969926127482827954674443846427813813222426';
'Remove orders for token 456789';

// Both parameters
'Cancel orders in market abc123 for token 456789';
'CANCEL_MARKET_ORDERS market=0x123abc assetId=789def';

// Natural language
'Stop all orders in the Trump 2024 market';
'Cancel my bets on Bitcoin reaching $100k';
```

**Key Features**:

- **Targeted Cancellation**: Cancel orders only for specific markets or assets
- **Flexible Parameters**: Use market ID, asset ID, or both for precise targeting
- **Intelligent Extraction**: Understands various ways of specifying identifiers
- **Comprehensive Error Handling**: Detailed error messages for different failure scenarios
- **Fallback Logic**: Regex pattern matching when LLM extraction fails
- **Selective Impact**: Other markets remain unaffected

**Use Cases**:

**Market-Specific Management**:

- Cancel all orders in a specific prediction market
- Clear positions from markets with unexpected news
- Exit all positions in a particular category (politics, crypto, sports)

**Asset-Specific Operations**:

- Cancel all orders for a specific token/outcome
- Clear YES or NO positions across multiple markets
- Remove orders for tokens with specific conditions

**Risk Management**:

- Quickly exit exposure to specific markets during volatility
- Cancel orders in markets with regulatory concerns
- Remove positions from markets approaching resolution

**Strategy Adjustments**:

- Clear orders from markets no longer fitting your strategy
- Rebalance exposure by removing orders from specific markets
- Focus trading activity by cancelling orders in less important markets

**Portfolio Optimization**:

- Remove orders from low-volume or stagnant markets
- Clear positions to free up capital for better opportunities
- Streamline order management by reducing active markets

**How to Find Market/Asset IDs**:

Market condition IDs and asset IDs can be obtained from:

- Market details queries (`GET_MARKET_DETAILS`)
- Active orders list (`GET_ACTIVE_ORDERS`)
- Order placement responses
- Market exploration APIs (`GET_ALL_MARKETS`, `GET_CLOB_MARKETS`)

**Error Handling**:

```typescript
// Missing parameters
'❌ Please provide a valid market condition ID and/or asset ID (token ID) to cancel orders';

// Invalid identifiers
'❌ Invalid market ID or asset ID. Please check the provided identifiers.';

// Authentication errors
'❌ Authentication failed. Please check your API credentials.';

// Network errors
'❌ Network connectivity issues. Please try again in a moment.';

// No orders found
'❌ No open orders found to cancel for the specified market.';

// API errors
'❌ An unexpected error occurred while cancelling market orders.';
```

**Important Considerations**:

**Precision vs. Scope**:

- More specific targeting means fewer orders cancelled
- Broader parameters (market only) cancel more orders
- Consider the scope of cancellation before execution

**Market Impact**:

- Cancelling many orders in a single market may affect liquidity
- Consider market size and activity before bulk cancellation
- Staggered cancellation may reduce market impact

**Timing**:

- Cancellation requests are processed immediately
- Some orders may fill during the cancellation process
- Network latency may affect exact timing

**Best Practices**:

1. **Verification**: Double-check market and asset IDs before cancellation
2. **Impact Assessment**: Consider the effect on market liquidity
3. **Timing**: Be aware of market hours and high-activity periods
4. **Follow-up**: Verify cancellation success and check remaining positions
5. **Documentation**: Keep records of cancelled orders for analysis

**Integration Examples**:

```typescript
// Market-specific emergency stop
const marketEmergencyStop = async (marketId: string) => {
  try {
    const result = await cancelMarketOrdersAction.handler(
      runtime,
      {
        content: { text: `Cancel all orders for market ${marketId}` },
      },
      state
    );

    if (result.data.success) {
      console.log(
        `Emergency stop: cancelled ${result.data.cancelledOrdersCount} orders in market ${marketId}`
      );
    }
  } catch (error) {
    console.error('Market emergency stop failed:', error);
  }
};

// Asset-specific cleanup
const assetCleanup = async (assetId: string) => {
  const result = await cancelMarketOrdersAction.handler(
    runtime,
    {
      content: { text: `Cancel orders for asset ${assetId}` },
    },
    state
  );

  return result.data.cancelledOrders;
};

// Combined market and asset targeting
const preciseCleanup = async (marketId: string, assetId: string) => {
  const result = await cancelMarketOrdersAction.handler(
    runtime,
    {
      content: { text: `Cancel orders in market ${marketId} for token ${assetId}` },
    },
    state
  );

  console.log(`Precise cleanup: ${result.data.message}`);
};
```
