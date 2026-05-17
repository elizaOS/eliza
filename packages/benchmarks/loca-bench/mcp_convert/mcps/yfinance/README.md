# YFinance MCP Server

A simplified Yahoo Finance MCP server using local file-based database instead of external APIs.

## Overview

This MCP server provides all 9 tools from the original YFinance implementation:

1. **get_historical_stock_prices** - Historical OHLCV data
2. **get_stock_info** - Comprehensive stock information  
3. **get_yahoo_finance_news** - News articles
4. **get_stock_actions** - Dividends and stock splits
5. **get_financial_statement** - Financial statements
6. **get_holder_info** - Institutional and insider holdings
7. **get_option_expiration_dates** - Options expiration dates
8. **get_option_chain** - Options chains
9. **get_recommendations** - Analyst recommendations

## Data Files

Located in `data/` directory:

- `stocks.json` - Basic stock information
- `historical_prices.csv` - Historical price data
- `news.json` - News articles
- `financial_statements.json` - Financial statements
- `holders.json` - Holder information
- `options.json` - Options data
- `stock_actions.json` - Dividends and splits
- `recommendations.json` - Analyst recommendations

## Sample Tickers

The server includes data for:
- **AAPL** (Apple Inc.)
- **GOOGL** (Alphabet Inc.)
- **MSFT** (Microsoft Corporation)
- **TSLA** (Tesla Inc.)

## Usage

### Running the Server

```bash
# From project root
uv run python mcps/yfinance/server.py
```

### Example Tool Calls

```python
# Get stock information
{"ticker": "AAPL"}

# Get historical prices
{"ticker": "AAPL", "period": "1mo", "interval": "1d"}

# Get financial statements
{"ticker": "AAPL", "financial_type": "income_stmt"}

# Get option chain
{"ticker": "AAPL", "expiration_date": "2024-03-15", "option_type": "calls"}
```

## Testing

Run the comprehensive test suite:

```bash
uv run pytest mcps/yfinance/test_server.py -v
```

## Configuration

Add to your `.mcp.json`:

```json
{
  "yfinance": {
    "command": "/opt/homebrew/Caskroom/miniforge/base/bin/uv",
    "args": [
      "--directory",
      "/Users/[username]/Desktop/mcp-convert",
      "run",
      "python",
      "mcps/yfinance/server.py"
    ]
  }
}
```

## Benefits

- ✅ **Offline functionality** - No internet required
- ✅ **No rate limits** - Unlimited queries
- ✅ **Fast responses** - Local file access
- ✅ **Consistent data** - Perfect for testing
- ✅ **Easy to extend** - Just modify JSON/CSV files