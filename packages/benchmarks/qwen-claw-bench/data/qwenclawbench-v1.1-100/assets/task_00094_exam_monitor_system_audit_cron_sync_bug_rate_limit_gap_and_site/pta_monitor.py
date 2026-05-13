#!/usr/bin/env python3
"""
Professional Qualification Exam Monitor
Monitors national and provincial personnel examination websites in China.
Sends Feishu notifications when new exam announcements are detected.
"""

import os
import sys
import json
import time
import hashlib
import logging
import datetime
import requests
from bs4 import BeautifulSoup
from pathlib import Path
from typing import List, Dict, Optional

# ── Configuration ──────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config" / "sites.json"
SEEN_DB_PATH = BASE_DIR / "data" / "seen_announcements.json"
LOG_DIR = BASE_DIR / "logs"
FEISHU_CONFIG_PATH = BASE_DIR / "config" / "feishu.json"

LOG_DIR.mkdir(parents=True, exist_ok=True)
Path(BASE_DIR / "data").mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / f"monitor_{datetime.date.today()}.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("pta_monitor")

# ── Feishu Notification ───────────────────────────────────────────────

def load_feishu_config() -> dict:
    with open(FEISHU_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def send_feishu_notification(title: str, content: str, url: str, source: str):
    """Send a rich-text card to Feishu via webhook."""
    cfg = load_feishu_config()
    webhook_url = cfg["webhook_url"]
    user_id = cfg.get("notify_user_id", "")

    payload = {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": f"📋 New Exam Notice: {title}"},
                "template": "blue",
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {
                        "tag": "lark_md",
                        "content": (
                            f"**Source:** {source}\n"
                            f"**Content:** {content[:300]}...\n"
                            f"**Link:** [{url}]({url})"
                        ),
                    },
                },
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "View Details"},
                            "url": url,
                            "type": "primary",
                        }
                    ],
                },
            ],
        },
    }

    if user_id:
        mention = f"<at id={user_id}></at> "
        payload["card"]["elements"].insert(0, {
            "tag": "div",
            "text": {"tag": "lark_md", "content": mention},
        })

    try:
        resp = requests.post(webhook_url, json=payload, timeout=10)
        resp.raise_for_status()
        logger.info(f"Feishu notification sent: {title}")
    except Exception as e:
        logger.error(f"Failed to send Feishu notification: {e}")


# ── Seen Announcements DB ─────────────────────────────────────────────

def load_seen_db() -> dict:
    if SEEN_DB_PATH.exists():
        with open(SEEN_DB_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"announcements": {}}


def save_seen_db(db: dict):
    with open(SEEN_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)


def is_new_announcement(db: dict, url: str, title: str) -> bool:
    key = hashlib.md5(f"{url}|{title}".encode()).hexdigest()
    return key not in db["announcements"]


def mark_seen(db: dict, url: str, title: str, source: str):
    key = hashlib.md5(f"{url}|{title}".encode()).hexdigest()
    db["announcements"][key] = {
        "url": url,
        "title": title,
        "source": source,
        "first_seen": datetime.datetime.now().isoformat(),
    }


# ── Site Scraping ──────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

EXAM_KEYWORDS = [
    "professional qualification",
    "registration notice",
    "exam announcement",
    "score release",
    "certificate collection",
    "exam schedule",
    "qualification exam",
    "practice qualification",
    "professional technical",
    "competency exam",
    # Chinese keywords (kept for matching Chinese page content)
    "职业资格",
    "报名通知",
    "考试公告",
    "成绩发布",
    "证书领取",
    "考试计划",
    "资格考试",
    "执业资格",
    "专业技术",
    "水平考试",
]


def matches_keywords(text: str) -> bool:
    text_lower = text.lower()
    return any(kw.lower() in text_lower for kw in EXAM_KEYWORDS)


def scrape_site(site_config: dict) -> List[Dict]:
    """Scrape a single examination website and return list of announcements."""
    name = site_config["name"]
    base_url = site_config["url"]
    list_path = site_config.get("list_path", "")
    link_selector = site_config.get("link_selector", "a")
    encoding = site_config.get("encoding", "utf-8")

    target_url = base_url.rstrip("/") + "/" + list_path.lstrip("/") if list_path else base_url
    announcements = []

    try:
        resp = requests.get(target_url, headers=HEADERS, timeout=15, verify=False)
        resp.encoding = encoding
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.warning(f"[{name}] Failed to fetch {target_url}: {e}")
        return announcements

    soup = BeautifulSoup(resp.text, "lxml")
    links = soup.select(link_selector)

    for link in links:
        title = link.get_text(strip=True)
        href = link.get("href", "")

        if not title or not href:
            continue

        if not matches_keywords(title):
            continue

        # Resolve relative URLs
        if href.startswith("/"):
            from urllib.parse import urlparse
            parsed = urlparse(base_url)
            href = f"{parsed.scheme}://{parsed.netloc}{href}"
        elif not href.startswith("http"):
            href = base_url.rstrip("/") + "/" + href

        announcements.append({
            "title": title,
            "url": href,
            "source": name,
        })

    logger.info(f"[{name}] Found {len(announcements)} matching announcements")
    return announcements


# ── Main Monitor Loop ──────────────────────────────────────────────────

def run_monitor():
    """Single monitoring pass across all configured sites."""
    logger.info("=" * 60)
    logger.info("Starting monitoring pass")

    # Check working hours (9:00 - 19:00)
    now = datetime.datetime.now()
    if not (9 <= now.hour < 19):
        logger.info(f"Outside working hours ({now.hour}:00). Skipping.")
        return

    # Load configuration
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    sites = [s for s in config["sites"] if s.get("enabled", True) and s.get("verified", False)]
    logger.info(f"Monitoring {len(sites)} verified sites")

    db = load_seen_db()
    new_count = 0

    for site in sites:
        try:
            announcements = scrape_site(site)
            for ann in announcements:
                if is_new_announcement(db, ann["url"], ann["title"]):
                    logger.info(f"NEW: [{ann['source']}] {ann['title']}")
                    send_feishu_notification(
                        title=ann["title"],
                        content=ann["title"],
                        url=ann["url"],
                        source=ann["source"],
                    )
                    mark_seen(db, ann["url"], ann["title"], ann["source"])
                    new_count += 1
        except Exception as e:
            logger.error(f"Error processing {site['name']}: {e}")

        # Polite delay between sites
        time.sleep(2)

    save_seen_db(db)
    logger.info(f"Pass complete. {new_count} new announcements found.")
    logger.info("=" * 60)


if __name__ == "__main__":
    run_monitor()
