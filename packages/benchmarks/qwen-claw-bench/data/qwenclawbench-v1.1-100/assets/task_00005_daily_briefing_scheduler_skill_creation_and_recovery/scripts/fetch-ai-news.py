#!/usr/bin/env python3
"""
Fetch and summarize AI news for daily briefing.
Called by cron job: daily-ai-news-report

Sources are configured in config/daily-reports.yaml
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta

DATA_DIR = "./data"
OUTPUT_FILE = os.path.join(DATA_DIR, "ai-news-latest.json")
CACHE_DIR = os.path.join(DATA_DIR, "news-cache")

def fetch_news_from_sources(sources):
    """Fetch headlines from configured news sources."""
    # In practice, this uses web_fetch or RSS parsing
    # Placeholder for the pipeline
    stories = []
    for source in sources:
        print(f"[{datetime.now().isoformat()}] Fetching from {source['name']}...")
        # Actual fetching handled by OpenClaw web_fetch tool
        # This script is called as part of the cron pipeline
    return stories

def summarize_stories(stories, model="gpt-4"):
    """Use LLM to generate concise summaries."""
    # Handled by OpenClaw agent in the cron job
    pass

def save_output(stories, output_path):
    """Save processed stories to JSON."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    output = {
        "date": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "story_count": len(stories),
        "stories": stories
    }
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"[{datetime.now().isoformat()}] Saved {len(stories)} stories to {output_path}")

if __name__ == "__main__":
    os.makedirs(CACHE_DIR, exist_ok=True)
    
    # Load config
    config_path = "config/daily-reports.yaml"
    if not os.path.exists(config_path):
        print(f"[ERROR] Config not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    
    print(f"[{datetime.now().isoformat()}] AI News fetch pipeline started")
    # Main logic is orchestrated by the OpenClaw cron agent
    # This script handles data I/O portions
