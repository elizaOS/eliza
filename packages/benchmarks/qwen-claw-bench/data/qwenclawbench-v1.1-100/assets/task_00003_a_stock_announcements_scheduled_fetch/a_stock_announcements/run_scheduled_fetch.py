#!/usr/bin/env python3
"""
A-Stock Announcements Scheduled Fetcher
========================================
Fetches latest company announcements from Chinese A-stock markets
(SSE / SZSE) via the cninfo disclosure API and eastmoney backup source.

Designed to run every 15 minutes via cron during trading hours,
or on-demand for catch-up fetches.

Usage:
    python3 run_scheduled_fetch.py                  # default: fetch last 15 min
    python3 run_scheduled_fetch.py --hours 2        # fetch last 2 hours
    python3 run_scheduled_fetch.py --date 2026-02-09  # fetch full day
"""

import os
import sys
import json
import time
import logging
import hashlib
import argparse
from datetime import datetime, timedelta
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from data.final_100.assets.task_00003_a_stock_announcements_scheduled_fetch.a_stock_announcements.fetcher.cninfo_client import CninfoClient
from data.final_100.assets.task_00003_a_stock_announcements_scheduled_fetch.a_stock_announcements.fetcher.eastmoney_client import EastmoneyClient
from data.final_100.assets.task_00003_a_stock_announcements_scheduled_fetch.a_stock_announcements.fetcher.dedup import DeduplicationStore
from fetcher.formatter import (
    format_announcement,
    save_announcements,
    generate_markdown_report,
    filter_announcements,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_PATH = PROJECT_ROOT / "config.json"
OUTPUT_DIR = PROJECT_ROOT / "output"
LOG_DIR = PROJECT_ROOT / "logs"
CACHE_DIR = PROJECT_ROOT / "cache"
DEDUP_DB = CACHE_DIR / "seen_hashes.json"

LOG_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_file = LOG_DIR / f"fetch_{datetime.now().strftime('%Y%m%d')}.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("scheduled_fetch")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Load and validate configuration from config.json."""
    if not CONFIG_PATH.exists():
        logger.error("config.json not found at %s", CONFIG_PATH)
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)
    required_fields = ["max_announcements_per_run"]
    for field in required_fields:
        if field not in config:
            logger.error(
                "config.json missing required field: '%s'. Please add it before running.",
                field,
            )
            sys.exit(1)
    return config


def compute_hash(ann: dict) -> str:
    """Compute a stable hash for deduplication."""
    key = f"{ann.get('stock_code', '')}-{ann.get('title', '')}-{ann.get('publish_time', '')}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def fetch_announcements(config: dict, start_time: datetime, end_time: datetime) -> list:
    """Fetch announcements from configured sources, with fallback."""
    all_announcements = []
    sources = config.get("sources", {})

    # Primary: cninfo
    if sources.get("cninfo", {}).get("enabled", True):
        try:
            client = CninfoClient(
                base_url=sources["cninfo"]["api_url"],
                timeout=config.get("request_timeout", 30),
            )
            anns = client.fetch_announcements(
                start_time=start_time,
                end_time=end_time,
                stock_codes=config.get("watchlist", []),
                categories=config.get("categories", []),
            )
            logger.info("cninfo returned %d announcements", len(anns))
            all_announcements.extend(anns)
        except Exception as e:
            logger.warning("cninfo fetch failed: %s", e)

    # Backup: eastmoney
    if sources.get("eastmoney", {}).get("enabled", True):
        try:
            client = EastmoneyClient(
                base_url=sources["eastmoney"]["api_url"],
                timeout=config.get("request_timeout", 30),
            )
            anns = client.fetch_announcements(
                start_time=start_time,
                end_time=end_time,
                stock_codes=config.get("watchlist", []),
            )
            logger.info("eastmoney returned %d announcements", len(anns))
            all_announcements.extend(anns)
        except Exception as e:
            logger.warning("eastmoney fetch failed: %s", e)

    return all_announcements


def main():
    parser = argparse.ArgumentParser(description="Fetch A-stock announcements")
    parser.add_argument("--hours", type=float, default=None, help="Fetch last N hours")
    parser.add_argument("--date", type=str, default=None, help="Fetch full day (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="Print but don't save")
    args = parser.parse_args()

    config = load_config()
    now = datetime.now()

    if args.date:
        start_time = datetime.strptime(args.date, "%Y-%m-%d")
        end_time = start_time + timedelta(days=1)
    elif args.hours:
        end_time = now
        start_time = now - timedelta(hours=args.hours)
    else:
        # Default: last interval (from config, default 15 min)
        interval_min = config.get("fetch_interval_minutes", 15)
        end_time = now
        start_time = now - timedelta(minutes=interval_min)

    logger.info("Fetching announcements from %s to %s", start_time, end_time)

    # Fetch
    announcements = fetch_announcements(config, start_time, end_time)

    # Filter to configured categories only
    categories = config.get("categories", [])
    announcements = filter_announcements(announcements, categories)
    logger.info("After category filter: %d announcements", len(announcements))

    # Enforce per-run limit
    max_per_run = config["max_announcements_per_run"]
    if len(announcements) > max_per_run:
        logger.warning(
            "Truncating from %d to %d announcements (max_announcements_per_run limit)",
            len(announcements),
            max_per_run,
        )
        announcements = announcements[:max_per_run]

    if not announcements:
        logger.info("No new announcements found.")
        return

    # Deduplicate
    dedup = DeduplicationStore(DEDUP_DB)
    new_announcements = []
    for ann in announcements:
        h = compute_hash(ann)
        if not dedup.seen(h):
            dedup.mark(h)
            new_announcements.append(ann)

    logger.info(
        "After dedup: %d new (of %d total)", len(new_announcements), len(announcements)
    )

    if not new_announcements:
        logger.info("All announcements already seen.")
        return

    if args.dry_run:
        for ann in new_announcements:
            print(json.dumps(ann, ensure_ascii=False, indent=2))
        return

    # Format and save
    formatted = [format_announcement(a) for a in new_announcements]
    out_file = save_announcements(formatted, OUTPUT_DIR, now)
    logger.info("Saved %d announcements to %s", len(formatted), out_file)

    # Also generate markdown report if configured
    cfg_output = config.get("output", {})
    if cfg_output.get("also_markdown", False):
        md_file = generate_markdown_report(formatted, OUTPUT_DIR, now)
        logger.info("Markdown report saved to %s", md_file)

    # Summary
    categories_count = {}
    for a in new_announcements:
        cat = a.get("category", "other")
        categories_count[cat] = categories_count.get(cat, 0) + 1

    summary = {
        "fetch_time": now.isoformat(),
        "window_start": start_time.isoformat(),
        "window_end": end_time.isoformat(),
        "total_fetched": len(announcements),
        "new_after_dedup": len(new_announcements),
        "categories": categories_count,
        "output_file": str(out_file),
    }
    logger.info("Summary: %s", json.dumps(summary, ensure_ascii=False))

    # Write latest summary for external consumption
    summary_path = OUTPUT_DIR / "latest_summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
