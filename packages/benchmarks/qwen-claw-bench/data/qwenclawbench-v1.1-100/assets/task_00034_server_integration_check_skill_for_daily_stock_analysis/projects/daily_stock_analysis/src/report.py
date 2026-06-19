"""
Report generation and Feishu notification for daily stock analysis.
"""

import os
import json
from datetime import datetime

import requests


def generate_report(signals: list[dict], output_dir: str = "data/reports") -> str:
    """Generate a JSON report from analysis signals."""
    os.makedirs(output_dir, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    report = {
        "generated_at": datetime.now().isoformat(),
        "total_symbols": len(signals),
        "signals": signals,
        "summary": {
            "strong_buy": sum(1 for s in signals if s["recommendation"] == "STRONG_BUY"),
            "buy": sum(1 for s in signals if s["recommendation"] == "BUY"),
            "hold": sum(1 for s in signals if s["recommendation"] == "HOLD"),
            "sell": sum(1 for s in signals if s["recommendation"] == "SELL"),
            "strong_sell": sum(1 for s in signals if s["recommendation"] == "STRONG_SELL"),
        },
    }
    path = os.path.join(output_dir, f"report_{date_str}.json")
    with open(path, "w") as f:
        json.dump(report, f, indent=2)
    return path


def send_feishu_notification(signals: list[dict], config: dict):
    """Send analysis summary to Feishu webhook."""
    webhook_url = config.get("feishu_webhook_url")
    if not webhook_url:
        raise ValueError("feishu_webhook_url not configured")

    buys = [s for s in signals if "BUY" in s["recommendation"]]
    sells = [s for s in signals if "SELL" in s["recommendation"]]

    lines = [f"📊 Daily Stock Analysis - {datetime.now().strftime('%Y-%m-%d')}"]
    if buys:
        lines.append(f"\n🟢 Buy Signals ({len(buys)}):")
        for s in buys:
            lines.append(f"  {s['symbol']}: {s['recommendation']} (RSI: {s['rsi_14']}, Close: {s['close']})")
    if sells:
        lines.append(f"\n🔴 Sell Signals ({len(sells)}):")
        for s in sells:
            lines.append(f"  {s['symbol']}: {s['recommendation']} (RSI: {s['rsi_14']}, Close: {s['close']})")

    payload = {
        "msg_type": "text",
        "content": {"text": "\n".join(lines)},
    }

    resp = requests.post(webhook_url, json=payload, timeout=10)
    resp.raise_for_status()
