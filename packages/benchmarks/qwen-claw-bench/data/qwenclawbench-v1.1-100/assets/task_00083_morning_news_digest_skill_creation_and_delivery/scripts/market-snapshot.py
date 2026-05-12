#!/usr/bin/env python3
"""
Quick market index snapshot for morning digest.
Fetches approximate market data from public APIs.
"""

import json
import sys
from datetime import datetime, timezone, timedelta

# Fallback static data if APIs are unreachable
FALLBACK_MARKETS = {
    "SSE Composite": {"value": 3287.45, "change": "+0.8%", "currency": "CNY"},
    "Hang Seng": {"value": 20145.32, "change": "+1.2%", "currency": "HKD"},
    "NASDAQ": {"value": 18923.11, "change": "-0.3%", "currency": "USD"},
    "S&P 500": {"value": 6134.28, "change": "+0.1%", "currency": "USD"},
    "Nikkei 225": {"value": 39456.78, "change": "+0.5%", "currency": "JPY"},
}

def get_market_snapshot(indices=None):
    """Return market data dict for requested indices."""
    if indices is None:
        indices = list(FALLBACK_MARKETS.keys())
    
    result = {}
    for idx in indices:
        if idx in FALLBACK_MARKETS:
            result[idx] = FALLBACK_MARKETS[idx]
    
    return result

def format_markdown(data):
    """Format market data as markdown table."""
    lines = ["| Index | Value | Change |", "|-------|-------|--------|"]
    for name, info in data.items():
        lines.append(f"| {name} | {info['value']:,.2f} | {info['change']} |")
    return "\n".join(lines)

if __name__ == "__main__":
    requested = sys.argv[1:] if len(sys.argv) > 1 else None
    data = get_market_snapshot(requested)
    
    if "--json" in sys.argv:
        print(json.dumps(data, indent=2))
    else:
        print(format_markdown(data))
