#!/usr/bin/env python3
"""
Crypto Price Tracker - Fetches BTC/ETH prices from CoinGecko.
Separate from the newsflash monitor. Used for portfolio dashboard.
"""

import json
import requests
from datetime import datetime, timezone

COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price"
WATCHLIST = ["bitcoin", "ethereum", "solana", "cardano", "polkadot"]


def get_prices(coins, vs_currency="usd"):
    """Fetch current prices for a list of coins."""
    params = {
        "ids": ",".join(coins),
        "vs_currencies": vs_currency,
        "include_24hr_change": "true",
        "include_market_cap": "true",
    }
    resp = requests.get(COINGECKO_API, params=params, timeout=10)
    resp.raise_for_status()
    return resp.json()


def format_price_report(data):
    """Format price data into a readable report."""
    lines = [f"📊 Price Report — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"]
    lines.append("=" * 50)
    for coin, info in data.items():
        price = info.get("usd", 0)
        change = info.get("usd_24h_change", 0)
        emoji = "🟢" if change >= 0 else "🔴"
        lines.append(f"{emoji} {coin.upper()}: ${price:,.2f} ({change:+.1f}%)")
    return "\n".join(lines)


if __name__ == "__main__":
    data = get_prices(WATCHLIST)
    print(format_price_report(data))
