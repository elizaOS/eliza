---
name: tushare-finance
description: "Query Chinese A-share stock market data via the Tushare Pro API. Use when: user asks about Chinese stocks, A-share prices, financial statements, fund NAVs, or index data. Requires a Tushare Pro API token."
homepage: https://tushare.pro
metadata:
  openclaw:
    emoji: "📈"
    requires:
      bins: ["python3", "curl"]
      env: ["TUSHARE_TOKEN"]
---

# Tushare Finance Skill

Query Chinese A-share market data through Tushare Pro.

## When to Use

✅ **USE this skill when:**

- "What's the price of 000001.SZ?"
- "Get daily quotes for Ping An Bank"
- "Show me the top gainers on the Shanghai exchange"
- "Financial statements for Kweichow Moutai"
- Fund NAV lookups, index composition queries

## When NOT to Use

❌ **DON'T use this skill when:**

- US/European stock data → use Yahoo Finance or Alpha Vantage
- Crypto prices → use crypto-specific APIs
- Real-time streaming quotes → Tushare is delayed/EOD
- News sentiment analysis → use news APIs

## Authentication

Requires `TUSHARE_TOKEN` environment variable. Get a token at https://tushare.pro/register

## Commands

### Daily Quotes

```bash
python3 skills/tushare-finance/scripts/query.py daily --ts_code 000001.SZ --start_date 20240101 --end_date 20240131
```

### Stock Info

```bash
python3 skills/tushare-finance/scripts/query.py stock_basic --exchange SSE --list_status L
```

### Financial Statements

```bash
python3 skills/tushare-finance/scripts/query.py income --ts_code 600519.SH --period 20231231
```

### Index Data

```bash
python3 skills/tushare-finance/scripts/query.py index_daily --ts_code 000001.SH --start_date 20240101
```

## Format Codes

- `ts_code` — Tushare stock code (e.g. 000001.SZ, 600519.SH)
- `trade_date` — Trading date YYYYMMDD
- `exchange` — SSE (Shanghai) or SZSE (Shenzhen)

## Notes

- Rate limits apply based on your Tushare membership tier
- Free tier: 200 calls/minute, limited historical depth
- Data is typically EOD (end of day), not real-time
- All monetary values in CNY unless specified
