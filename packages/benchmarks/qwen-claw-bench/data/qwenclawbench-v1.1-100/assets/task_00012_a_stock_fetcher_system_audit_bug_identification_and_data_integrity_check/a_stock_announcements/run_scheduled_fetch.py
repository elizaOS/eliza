#!/usr/bin/env python3
"""
A-Stock Announcements Scheduled Fetcher
========================================
Fetches latest company announcements from Chinese A-stock markets (SSE & SZSE)
via the cninfo.com.cn disclosure API. Designed to run every 15 minutes via cron.

Usage:
    python3 run_scheduled_fetch.py [--full] [--debug]

Options:
    --full      Fetch all pages instead of latest only
    --debug     Enable debug logging
"""

import os
import sys
import json
import time
import logging
import hashlib
import argparse
import datetime
from pathlib import Path

import requests
import yaml

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.yaml"
STATE_PATH = SCRIPT_DIR / "fetch_state.json"
OUTPUT_DIR = SCRIPT_DIR / "output"
LOG_DIR = SCRIPT_DIR / "logs"

OUTPUT_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)

log_file = LOG_DIR / f"fetch_{datetime.date.today().isoformat()}.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("a_stock_fetch")


def load_config() -> dict:
    """Load YAML configuration."""
    if not CONFIG_PATH.exists():
        logger.error("config.yaml not found at %s", CONFIG_PATH)
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_state() -> dict:
    """Load persisted fetch state (last seen IDs, timestamps)."""
    if STATE_PATH.exists():
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"last_fetch_ts": None, "seen_ids": []}


def save_state(state: dict):
    """Persist fetch state to disk."""
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def build_headers(cfg: dict) -> dict:
    """Build HTTP headers for cninfo API requests."""
    return {
        "User-Agent": cfg.get("user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
        "Accept": "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "http://www.cninfo.com.cn/new/disclosure",
        "X-Requested-With": "XMLHttpRequest",
    }


def fetch_announcements(cfg: dict, full: bool = False) -> list:
    """
    Fetch announcements from the cninfo disclosure API.

    Endpoint: http://www.cninfo.com.cn/new/hisAnnouncement/query
    Params:
        pageNum, pageSize, column (szse/sse), tabName, plate, seDate, ...
    """
    api_url = cfg["api"]["base_url"]
    params = {
        "pageNum": 1,
        "pageSize": cfg["api"].get("page_size", 30),
        "column": cfg["api"].get("column", "szse"),
        "tabName": cfg["api"].get("tab_name", "fulltext"),
        "plate": "",
        "stock": "",
        "searchkey": "",
        "secid": "",
        "category": cfg["api"].get("category", "category_ndbg_szsh"),
        "trade": "",
        "seDate": "",
        "sortName": "",
        "sortType": "",
        "isHLtitle": "true",
    }

    headers = build_headers(cfg)
    all_announcements = []
    max_pages = cfg["api"].get("max_pages", 3) if not full else 20

    for page in range(1, max_pages + 1):
        params["pageNum"] = page
        logger.info("Fetching page %d from %s (column=%s)", page, api_url, params["column"])

        try:
            resp = requests.post(api_url, data=params, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as exc:
            logger.error("Request failed on page %d: %s", page, exc)
            break
        except json.JSONDecodeError:
            logger.error("Invalid JSON response on page %d", page)
            break

        announcements = data.get("announcements", [])
        if not announcements:
            logger.info("No more announcements on page %d, stopping.", page)
            break

        all_announcements.extend(announcements)
        logger.info("Got %d announcements on page %d", len(announcements), page)

        # Polite delay between pages
        time.sleep(cfg["api"].get("request_delay", 1.5))

    # Also fetch from SSE if configured
    if cfg["api"].get("fetch_sse", True) and params["column"] != "sse":
        params["column"] = "sse"
        params["pageNum"] = 1
        logger.info("Fetching SSE announcements...")
        try:
            resp = requests.post(api_url, data=params, headers=headers, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            sse_anns = data.get("announcements", [])
            all_announcements.extend(sse_anns)
            logger.info("Got %d SSE announcements", len(sse_anns))
        except Exception as exc:
            logger.warning("SSE fetch failed: %s", exc)

    return all_announcements


def deduplicate(announcements: list, state: dict) -> list:
    """Remove already-seen announcements based on announcementId."""
    seen = set(state.get("seen_ids", []))
    new_anns = []
    for ann in announcements:
        ann_id = ann.get("announcementId", "")
        if ann_id and ann_id not in seen:
            new_anns.append(ann)
            seen.add(ann_id)
    # Keep only last 5000 IDs to avoid unbounded growth
    state["seen_ids"] = list(seen)[-5000:]
    return new_anns


def save_announcements(announcements: list, cfg: dict):
    """Save announcements to date-partitioned JSON files in output/."""
    if not announcements:
        logger.info("No new announcements to save.")
        return

    today = datetime.date.today().isoformat()
    out_file = OUTPUT_DIR / f"announcements_{today}.json"

    # Merge with existing if file already exists
    existing = []
    if out_file.exists():
        with open(out_file, "r", encoding="utf-8") as f:
            existing = json.load(f)

    merged = existing + announcements
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)

    logger.info("Saved %d new announcements to %s (total: %d)", len(announcements), out_file, len(merged))

    # Optional: save summary CSV
    if cfg.get("output", {}).get("csv_summary", False):
        save_csv_summary(announcements, today)


def save_csv_summary(announcements: list, date_str: str):
    """Write a lightweight CSV summary of today's announcements."""
    import csv

    csv_path = OUTPUT_DIR / f"summary_{date_str}.csv"
    file_exists = csv_path.exists()
    with open(csv_path, "a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(["announcement_id", "stock_code", "stock_name", "title", "publish_time", "url"])
        for ann in announcements:
            writer.writerow([
                ann.get("announcementId", ""),
                ann.get("secCode", ""),
                ann.get("secName", ""),
                ann.get("announcementTitle", ""),
                ann.get("announcementTime", ""),
                f"http://www.cninfo.com.cn/new/disclosure/detail?annoId={ann.get('announcementId', '')}",
            ])


def send_notification(new_count: int, cfg: dict):
    """Send notification if configured (webhook / log only)."""
    notify_cfg = cfg.get("notifications", {})
    if not notify_cfg.get("enabled", False):
        return
    if new_count < notify_cfg.get("min_count", 1):
        return

    webhook_url = notify_cfg.get("webhook_url")
    if webhook_url:
        payload = {
            "text": f"A-Stock Announcements: {new_count} new announcements fetched at {datetime.datetime.now().isoformat()}",
        }
        try:
            requests.post(webhook_url, json=payload, timeout=10)
            logger.info("Notification sent to webhook.")
        except Exception as exc:
            logger.warning("Webhook notification failed: %s", exc)


def main():
    parser = argparse.ArgumentParser(description="Fetch A-stock announcements")
    parser.add_argument("--full", action="store_true", help="Fetch all pages")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    logger.info("=" * 60)
    logger.info("A-Stock Announcements Fetch - %s", datetime.datetime.now().isoformat())
    logger.info("=" * 60)

    cfg = load_config()
    state = load_state()

    announcements = fetch_announcements(cfg, full=args.full)
    logger.info("Total raw announcements fetched: %d", len(announcements))

    new_announcements = deduplicate(announcements, state)
    logger.info("New (unseen) announcements: %d", len(new_announcements))

    save_announcements(new_announcements, cfg)

    state["last_fetch_ts"] = datetime.datetime.now().isoformat()
    save_state(state)

    send_notification(len(new_announcements), cfg)

    logger.info("Fetch complete. %d new announcements processed.", len(new_announcements))


if __name__ == "__main__":
    main()
