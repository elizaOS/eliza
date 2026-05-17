#!/usr/bin/env python3
"""
Deduplication module for Moltbook monitor.
Compares incoming posts against a seen-posts cache file.
Supports strategies: post_id, content_hash, title_similarity.
"""

import argparse
import json
import hashlib
import sys
import time
from pathlib import Path


def content_hash(post: dict) -> str:
    """SHA-256 of title + author for content-based dedup."""
    raw = f"{post.get('title', '')}|{post.get('author_id', '')}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def dedup_posts(posts: list, seen: dict, window_hours: int, strategy: str) -> list:
    cutoff = time.time() - (window_hours * 3600)

    # Prune expired entries from seen cache
    seen_pruned = {k: v for k, v in seen.items() if v.get("ts", 0) > cutoff}

    new_posts = []
    for post in posts:
        if strategy == "post_id":
            key = str(post.get("id", ""))
        elif strategy == "content_hash":
            key = content_hash(post)
        elif strategy == "title_similarity":
            # Simplified: exact title match
            key = post.get("title", "").strip().lower()
        else:
            key = str(post.get("id", ""))

        if key and key not in seen_pruned:
            new_posts.append(post)
            seen_pruned[key] = {"ts": time.time(), "title": post.get("title", "")[:80]}

    return new_posts, seen_pruned


def main():
    parser = argparse.ArgumentParser(description="Moltbook post deduplication")
    parser.add_argument("--input", required=True, help="Input JSON file/pipe with posts")
    parser.add_argument("--seen", required=True, help="Path to seen_posts.json cache")
    parser.add_argument("--window-hours", type=int, default=12, help="Dedup window in hours")
    parser.add_argument("--strategy", default="post_id",
                        choices=["post_id", "content_hash", "title_similarity"])
    args = parser.parse_args()

    # Read input
    if args.input == "-":
        data = json.load(sys.stdin)
    else:
        with open(args.input) as f:
            data = json.load(f)

    posts = data.get("posts", [])

    # Read seen cache
    seen_path = Path(args.seen)
    if seen_path.exists():
        with open(seen_path) as f:
            seen = json.load(f)
    else:
        seen = {}

    new_posts, updated_seen = dedup_posts(posts, seen, args.window_hours, args.strategy)

    # Write updated seen cache
    with open(seen_path, "w") as f:
        json.dump(updated_seen, f, indent=2, ensure_ascii=False)

    # Output new posts
    result = {"posts": new_posts, "total": len(new_posts)}
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
