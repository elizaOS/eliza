#!/usr/bin/env python3
"""
Stable literature retrieval — fallback version that uses direct HTTP
instead of feedparser to avoid import errors in cron environments.

This was created after repeated cron failures where feedparser was
not available in the execution environment.

Changes from real_rss_literature_retrieval.py:
  - Uses urllib.request instead of feedparser
  - Basic XML parsing with xml.etree.ElementTree
  - More aggressive error handling
  - Writes detailed error log on failure
"""

import json
import os
import sys
import hashlib
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data.final_100.assets.task_00055_literature_retrieval_bot_error_diagnosis_and_config_fix.scripts.verified_rss_sources import get_enabled_sources, KEYWORD_WEIGHTS, RELEVANCE_THRESHOLD

RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "literature_results")
TRACKER_PATH = os.path.join(RESULTS_DIR, "master_progress_tracker.json")
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cron_logs")

def log_error(message, context=None):
    """Write error to cron log directory."""
    os.makedirs(LOG_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = os.path.join(LOG_DIR, f"stable_retrieval_error_{ts}.log")
    with open(log_path, "a") as f:
        f.write(f"[{datetime.now(timezone.utc).isoformat()}] {message}\n")
        if context:
            f.write(f"  Context: {json.dumps(context)}\n")
    return log_path

def fetch_rss_urllib(url, timeout=30):
    """Fetch RSS feed using urllib and parse with ElementTree."""
    headers = {
        "User-Agent": "LiteratureRetrieval/2.0 (academic research; contact: research@example.edu)",
        "Accept": "application/rss+xml, application/xml, text/xml",
    }
    req = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content = response.read()
            # Check if we got HTML instead of XML (Nature RSS issue)
            if b"<!DOCTYPE html" in content[:200].lower() or b"<html" in content[:200].lower():
                raise ValueError("Received HTML instead of XML feed")
            return content
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise RuntimeError(f"Rate limited (429) — back off required for {url}")
        raise

def parse_rss_xml(xml_content):
    """Parse RSS XML content into article dicts."""
    root = ET.fromstring(xml_content)
    articles = []

    # Handle RSS 2.0
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        description = (item.findtext("description") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        author = (item.findtext("{http://purl.org/dc/elements/1.1/}creator") or
                  item.findtext("author") or "").strip()

        if title and link:
            articles.append({
                "title": title,
                "url": link,
                "summary": description[:500],
                "published": pub_date,
                "authors": author,
            })

    # Handle Atom feeds
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    for entry in root.findall(".//atom:entry", ns):
        title = (entry.findtext("atom:title", namespaces=ns) or "").strip()
        link_elem = entry.find("atom:link[@rel='alternate']", ns)
        if link_elem is None:
            link_elem = entry.find("atom:link", ns)
        link = link_elem.get("href", "") if link_elem is not None else ""
        summary = (entry.findtext("atom:summary", namespaces=ns) or "").strip()
        published = (entry.findtext("atom:published", namespaces=ns) or
                     entry.findtext("atom:updated", namespaces=ns) or "").strip()

        if title and link:
            articles.append({
                "title": title,
                "url": link,
                "summary": summary[:500],
                "published": published,
                "authors": "",
            })

    return articles

def generate_article_id(title, url):
    raw = f"{title.strip().lower()}|{url.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

def score_article(title, summary):
    text = f"{title} {summary}".lower()
    total = 0
    matched = []
    for keyword, weight in KEYWORD_WEIGHTS.items():
        if keyword.lower() in text:
            total += weight
            matched.append(keyword)
    return total, matched

def load_tracker():
    if os.path.exists(TRACKER_PATH):
        with open(TRACKER_PATH, "r") as f:
            return json.load(f)
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "total_articles": 0,
        "last_run": None,
        "runs": [],
        "seen_ids": [],
        "articles": [],
    }

def save_tracker(tracker):
    os.makedirs(os.path.dirname(TRACKER_PATH), exist_ok=True)
    with open(TRACKER_PATH, "w") as f:
        json.dump(tracker, f, indent=2)

def main():
    tracker = load_tracker()
    seen_ids = set(tracker.get("seen_ids", []))
    sources = get_enabled_sources()

    run_ts = datetime.now(timezone.utc).isoformat()
    stats = {
        "timestamp": run_ts,
        "sources_checked": 0,
        "articles_found": 0,
        "articles_new": 0,
        "articles_relevant": 0,
        "errors": [],
        "script": "stable_literature_retrieval.py",
    }

    new_articles = []

    for key, source in sources.items():
        stats["sources_checked"] += 1
        print(f"[{key}] Fetching {source['name']}...")

        try:
            xml_content = fetch_rss_urllib(source["url"])
            raw_articles = parse_rss_xml(xml_content)
            stats["articles_found"] += len(raw_articles)

            for raw in raw_articles:
                aid = generate_article_id(raw["title"], raw["url"])
                if aid in seen_ids:
                    continue

                score, keywords = score_article(raw["title"], raw["summary"])
                seen_ids.add(aid)
                stats["articles_new"] += 1

                if score >= RELEVANCE_THRESHOLD:
                    stats["articles_relevant"] += 1
                    article = {
                        "id": aid,
                        **raw,
                        "source": source["name"],
                        "category": source["category"],
                        "relevance_score": score,
                        "matched_keywords": keywords,
                        "retrieved_at": run_ts,
                    }
                    new_articles.append(article)
                    print(f"  + [{score:>3}] {raw['title'][:80]}")

            time.sleep(0.5)

        except Exception as e:
            err = f"[{key}] {type(e).__name__}: {str(e)}"
            stats["errors"].append(err)
            log_error(err, {"source_key": key, "url": source["url"]})
            print(f"  ERROR: {err}", file=sys.stderr)

    # Update tracker
    tracker["articles"].extend(new_articles)
    tracker["seen_ids"] = list(seen_ids)
    tracker["total_articles"] = len(tracker["articles"])
    tracker["last_run"] = run_ts
    tracker["runs"].append(stats)
    save_tracker(tracker)

    # Save run file
    os.makedirs(RESULTS_DIR, exist_ok=True)
    run_file = os.path.join(RESULTS_DIR, f"stable_run_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
    with open(run_file, "w") as f:
        json.dump({"stats": stats, "new_articles": new_articles}, f, indent=2)

    print(f"\nSaved: {run_file}")
    print(f"Sources: {stats['sources_checked']} | Found: {stats['articles_found']} | New: {stats['articles_new']} | Relevant: {stats['articles_relevant']} | Errors: {len(stats['errors'])}")

    if stats["errors"]:
        sys.exit(1)

if __name__ == "__main__":
    main()
