#!/usr/bin/env python3
"""
daily_stock_analysis - Main entry point
Fetches daily OHLCV data, computes technical indicators, and generates reports.
"""

import os
import sys
import logging
import argparse
from datetime import datetime, timedelta

import pandas as pd
import yfinance as yf

from data.final_100.assets.task_00034_server_integration_check_skill_for_daily_stock_analysis.projects.daily_stock_analysis.src.indicators import compute_rsi, compute_macd, compute_bollinger
from data.final_100.assets.task_00034_server_integration_check_skill_for_daily_stock_analysis.projects.daily_stock_analysis.src.report import generate_report, send_feishu_notification
from data.final_100.assets.task_00034_server_integration_check_skill_for_daily_stock_analysis.projects.daily_stock_analysis.src.config import load_config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(os.path.dirname(__file__), "..", "logs", "analysis.log")),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("daily_stock_analysis")


def fetch_data(symbols: list[str], period: str = "6mo") -> dict[str, pd.DataFrame]:
    """Fetch OHLCV data for a list of symbols."""
    results = {}
    for sym in symbols:
        logger.info(f"Fetching data for {sym}...")
        try:
            df = yf.download(sym, period=period, progress=False)
            if df.empty:
                logger.warning(f"No data returned for {sym}")
                continue
            results[sym] = df
        except Exception as e:
            logger.error(f"Failed to fetch {sym}: {e}")
    return results


def analyze(data: dict[str, pd.DataFrame], config: dict) -> list[dict]:
    """Run technical analysis on fetched data."""
    signals = []
    for sym, df in data.items():
        rsi = compute_rsi(df["Close"], window=config.get("rsi_window", 14))
        macd_line, signal_line, histogram = compute_macd(df["Close"])
        upper, middle, lower = compute_bollinger(df["Close"])

        latest = df.iloc[-1]
        signal = {
            "symbol": sym,
            "date": str(latest.name.date()),
            "close": round(float(latest["Close"]), 2),
            "volume": int(latest["Volume"]),
            "rsi_14": round(float(rsi.iloc[-1]), 2),
            "macd": round(float(macd_line.iloc[-1]), 4),
            "macd_signal": round(float(signal_line.iloc[-1]), 4),
            "bb_upper": round(float(upper.iloc[-1]), 2),
            "bb_lower": round(float(lower.iloc[-1]), 2),
            "recommendation": "",
        }

        # Simple signal logic
        if signal["rsi_14"] < 30 and latest["Close"] <= lower.iloc[-1]:
            signal["recommendation"] = "STRONG_BUY"
        elif signal["rsi_14"] < 40:
            signal["recommendation"] = "BUY"
        elif signal["rsi_14"] > 70 and latest["Close"] >= upper.iloc[-1]:
            signal["recommendation"] = "STRONG_SELL"
        elif signal["rsi_14"] > 60:
            signal["recommendation"] = "SELL"
        else:
            signal["recommendation"] = "HOLD"

        signals.append(signal)
        logger.info(f"{sym}: RSI={signal['rsi_14']}, MACD={signal['macd']}, Rec={signal['recommendation']}")

    return signals


def main():
    parser = argparse.ArgumentParser(description="Daily Stock Analysis Pipeline")
    parser.add_argument("--config", default="config/settings.yaml", help="Path to config file")
    parser.add_argument("--dry-run", action="store_true", help="Skip notifications")
    args = parser.parse_args()

    config = load_config(args.config)
    symbols = config.get("watchlist", [])

    if not symbols:
        logger.error("No symbols in watchlist. Exiting.")
        sys.exit(1)

    logger.info(f"Starting daily analysis for {len(symbols)} symbols...")
    data = fetch_data(symbols, period=config.get("lookback_period", "6mo"))
    signals = analyze(data, config)

    report_path = generate_report(signals, output_dir=config.get("report_dir", "data/reports"))
    logger.info(f"Report saved to {report_path}")

    if not args.dry_run and config.get("feishu_notify", False):
        send_feishu_notification(signals, config)
        logger.info("Feishu notification sent.")

    logger.info("Analysis complete.")


if __name__ == "__main__":
    main()
