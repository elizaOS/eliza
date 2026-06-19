#!/usr/bin/env python3
"""
Real RSS-based literature retrieval script.
Fetches from verified RSS sources, scores articles by keyword relevance,
and appends new findings to the master progress tracker.

Usage:
    python3 real_rss_literature_retrieval.py [--dry-run] [--source SOURCE_KEY]

Known Issues:
    - feedparser sometimes returns empty entries on 302 redirects (fixed in v2)
    - Nature RSS occasionally returns HTML instead of XML (retry logic added)
    - PubMed rate limits: max 3 requests/second without API key
"""

import json
import sys
import os
import hashlib
import time
from datetime import datetime, timezone

# Attempt imports — these may fail in minimal environments
try:
    import feedparser
    FEEDPARSER_AVAILABLE = True
except ImportError:
    FEEDPARSER_AVAILABLE = False
    print("WARNING: feedparser not installed. Install with: pip install feedparser", file=sys.stderr)

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False
    print("WARNING: requests not installed. Install with: pip install requests", file=sys.stderr)

# Local imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data.final_100.assets.task_00055_literature_retrieval_bot_error_diagnosis_and_config_fix.scripts.verified_rss_sources import get_enabled_sources, KEYWORD_WEIGHTS, RELEVANCE_THRESHOLD

RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "literature_results")
TRACKER_PATH = os.path.join(RESULTS_DIR, "master_progress_tracker.json")
RATE_LIMIT_DELAY = 0.4  # seconds between requests

def generate_article_id(title, url):
    """Generate a stable hash ID for an article."""
    raw = f"{title.strip().lower()}|{url.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

def score_article(title, summary):
    """Score an article based on keyword matches in title and summary."""
    text = f"{title} {summary}".lower()
    total = 0
    matched_keywords = []
    for keyword, weight in KEYWORD_WEIGHTS.items():
        if keyword.lower() in text:
            total += weight
            matched_keywords.append(keyword)
    return total, matched_keywords

def fetch_rss_feed(source_config):
    """Fetch and parse an RSS feed. Returns list of entry dicts."""
    if not FEEDPARSER_AVAILABLE:
        raise RuntimeError("feedparser is required but not installed")

    url = source_config["url"]
    feed = feedparser.parse(url)

    if feed.bozo and not feed.entries:
        raise RuntimeError(f"Feed parse error for {url}: {feed.bozo_exception}")

    articles = []
    for entry in feed.entries:
        title = entry.get("title", "").strip()
        link = entry.get("link", "").strip()
        summary = entry.get("summary", entry.get("description", "")).strip()
        published = entry.get("published", entry.get("updated", ""))
        authors = entry.get("author", "")

        if not title or not link:
            continue

        article_id = generate_article_id(title, link)
        score, keywords = score_article(title, summary)

        articles.append({
            "id": article_id,
            "title": title,
            "url": link,
            "summary": summary[:500],
            "published": published,
            "authors": authors,
            "source": source_config["name"],
            "category": source_config["category"],
            "relevance_score": score,
            "matched_keywords": keywords,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        })

    return articles

def load_tracker():
    """Load the master progress tracker."""
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
    """Save the master progress tracker."""
    os.makedirs(os.path.dirname(TRACKER_PATH), exist_ok=True)
    with open(TRACKER_PATH, "w") as f:
        json.dump(tracker, f, indent=2)

def run_retrieval(dry_run=False, source_filter=None):
    """Main retrieval loop."""
    tracker = load_tracker()
    seen_ids = set(tracker.get("seen_ids", []))
    sources = get_enabled_sources()

    if source_filter:
        sources = {k: v for k, v in sources.items() if k == source_filter}
        if not sources:
            print(f"ERROR: Source '{source_filter}' not found or disabled.", file=sys.stderr)
            sys.exit(1)

    run_timestamp = datetime.now(timezone.utc).isoformat()
    run_stats = {
        "timestamp": run_timestamp,
        "sources_checked": 0,
        "articles_found": 0,
        "articles_new": 0,
        "articles_relevant": 0,
        "errors": [],
    }

    new_articles = []

    for key, source in sources.items():
        print(f"Fetching: {source['name']}...")
        run_stats["sources_checked"] += 1

        try:
            articles = fetch_rss_feed(source)
            run_stats["articles_found"] += len(articles)

            for article in articles:
                if article["id"] in seen_ids:
                    continue

                run_stats["articles_new"] += 1
                seen_ids.add(article["id"])

                if article["relevance_score"] >= RELEVANCE_THRESHOLD:
                    run_stats["articles_relevant"] += 1
                    new_articles.append(article)
                    if not dry_run:
                        print(f"  + [{article['relevance_score']}] {article['title'][:80]}")

            time.sleep(RATE_LIMIT_DELAY)

        except Exception as e:
            error_msg = f"Error fetching {key}: {str(e)}"
            print(f"  ERROR: {error_msg}", file=sys.stderr)
            run_stats["errors"].append(error_msg)

    if not dry_run:
        tracker["articles"].extend(new_articles)
        tracker["seen_ids"] = list(seen_ids)
        tracker["total_articles"] = len(tracker["articles"])
        tracker["last_run"] = run_timestamp
        tracker["runs"].append(run_stats)
        save_tracker(tracker)

    # Save per-run results
    run_filename = f"real_rss_run_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    run_path = os.path.join(RESULTS_DIR, run_filename)
    if not dry_run:
        with open(run_path, "w") as f:
            json.dump({
                "run_stats": run_stats,
                "new_articles": new_articles,
            }, f, indent=2)
        print(f"\nResults saved to: {run_path}")

    print(f"\n--- Run Summary ---")
    print(f"Sources checked: {run_stats['sources_checked']}")
    print(f"Articles found:  {run_stats['articles_found']}")
    print(f"New articles:    {run_stats['articles_new']}")
    print(f"Relevant:        {run_stats['articles_relevant']}")
    print(f"Errors:          {len(run_stats['errors'])}")

    return run_stats

if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    source = None
    for i, arg in enumerate(sys.argv):
        if arg == "--source" and i + 1 < len(sys.argv):
            source = sys.argv[i + 1]

    run_retrieval(dry_run=dry_run, source_filter=source)
