#!/usr/bin/env python3
"""
BlockBeats Newsflash Monitor
Fetches latest crypto newsflash items from BlockBeats open API,
detects new entries since last check, and sends notifications.
"""

import json
import os
import sys
import time
import re
import html
import requests
from datetime import datetime, timezone
from pathlib import Path

# Paths
SCRIPT_DIR = Path(__file__).parent
STATE_FILE = SCRIPT_DIR.parent / "data" / "blockbeats_state.json"
CONFIG_FILE = SCRIPT_DIR.parent / "config" / "monitor_config.json"
LOG_DIR = SCRIPT_DIR.parent / "logs"

# Defaults
DEFAULT_API_URL = "https://api.theblockbeats.news/v1/open-api/open-flash"
DEFAULT_PAGE_SIZE = 20
DEFAULT_CHECK_TYPE = "push"


def load_config():
    """Load monitor configuration."""
    config = {
        "api_url": DEFAULT_API_URL,
        "page_size": DEFAULT_PAGE_SIZE,
        "type": DEFAULT_CHECK_TYPE,
        "keywords": [],
        "notify_channel": None,
        "translate": True,
        "log_level": "info",
    }
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            user_config = json.load(f)
            config.update(user_config)
    return config


def load_state():
    """Load last seen state."""
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"last_id": 0, "last_check": 0}


def save_state(state):
    """Persist state to disk."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def strip_html(text):
    """Remove HTML tags and decode entities."""
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return text.strip()


def fetch_newsflash(config):
    """Fetch latest newsflash items from BlockBeats API."""
    params = {
        "size": config["page_size"],
        "page": 1,
        "type": config["type"],
    }
    headers = {
        "User-Agent": "BlockBeatsMonitor/1.0",
        "Accept": "application/json",
    }
    resp = requests.get(config["api_url"], params=params, headers=headers, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != 0:
        raise RuntimeError(f"API returned error status: {data.get('message', 'unknown')}")

    items = data.get("data", {}).get("data", [])
    return items


def filter_by_keywords(items, keywords):
    """Filter items that match any keyword (case-insensitive)."""
    if not keywords:
        return items
    filtered = []
    for item in items:
        text = (item.get("title", "") + " " + strip_html(item.get("content", ""))).lower()
        if any(kw.lower() in text for kw in keywords):
            filtered.append(item)
    return filtered


def format_flash(item):
    """Format a single newsflash item for notification."""
    title = item.get("title", "No title")
    content = strip_html(item.get("content", ""))
    link = item.get("link", "")
    ts = int(item.get("create_time", 0))
    dt = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines = [
        f"📰 **{title}**",
        f"🕐 {dt}",
        "",
        content[:500],
    ]
    if link:
        lines.append(f"\n🔗 {link}")
    return "\n".join(lines)


def log_message(msg, level="info"):
    """Write log entry."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / f"monitor_{datetime.now(timezone.utc).strftime('%Y%m%d')}.log"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] [{level.upper()}] {msg}\n")


def main():
    config = load_config()
    state = load_state()
    last_id = state.get("last_id", 0)

    log_message(f"Starting check. Last seen ID: {last_id}")

    try:
        items = fetch_newsflash(config)
    except Exception as e:
        log_message(f"Failed to fetch newsflash: {e}", level="error")
        print(f"ERROR: Failed to fetch newsflash: {e}", file=sys.stderr)
        sys.exit(1)

    if not items:
        log_message("No items returned from API")
        print("No new items.")
        return

    # Sort by ID ascending
    items.sort(key=lambda x: int(x.get("id", 0)))

    # Filter new items
    new_items = [i for i in items if int(i.get("id", 0)) > last_id]

    if config.get("keywords"):
        new_items = filter_by_keywords(new_items, config["keywords"])

    if not new_items:
        log_message(f"No new items since ID {last_id}. Latest API ID: {items[-1].get('id')}")
        print("No new items since last check.")
        # Still update last_id to latest
        state["last_id"] = int(items[-1].get("id", last_id))
        state["last_check"] = int(time.time())
        save_state(state)
        return

    log_message(f"Found {len(new_items)} new item(s)")

    # Output formatted items
    for item in new_items:
        formatted = format_flash(item)
        print(formatted)
        print("---")
        log_message(f"New flash: ID={item.get('id')} title={item.get('title', '')[:60]}")

    # Update state
    max_id = max(int(i.get("id", 0)) for i in new_items)
    state["last_id"] = max(last_id, max_id)
    state["last_check"] = int(time.time())
    save_state(state)

    log_message(f"Check complete. New last_id: {state['last_id']}")
    print(f"\nProcessed {len(new_items)} new newsflash item(s).")


if __name__ == "__main__":
    main()
