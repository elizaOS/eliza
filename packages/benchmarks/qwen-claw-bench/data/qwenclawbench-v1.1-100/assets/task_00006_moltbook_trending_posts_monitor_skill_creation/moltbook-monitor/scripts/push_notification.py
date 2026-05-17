#!/usr/bin/env python3
"""
Push notification dispatcher for Moltbook monitor.
Reads config and posts, formats messages, and sends to configured channels.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None


def load_config(config_path: str) -> dict:
    with open(config_path) as f:
        if yaml:
            return yaml.safe_load(f)
        # Fallback: rudimentary parse (not production-safe)
        raise RuntimeError("PyYAML not installed; cannot parse config")


def format_markdown(posts: list, max_posts: int = 10) -> str:
    lines = [f"## 🔥 Moltbook Trending Posts ({len(posts[:max_posts])} new)\n"]
    for i, post in enumerate(posts[:max_posts], 1):
        score = post.get("score", 0)
        title = post.get("title", "Untitled")
        author = post.get("author_name", "Unknown")
        url = post.get("url", "#")
        category = post.get("category", "")
        emoji = "🔴" if score >= 2000 else "🟠" if score >= 500 else "🟢"
        lines.append(f"{i}. {emoji} **[{title}]({url})** — {score}pts")
        lines.append(f"   by {author} | {category}\n")
    return "\n".join(lines)


def format_html(posts: list, max_posts: int = 10) -> str:
    lines = [f"<b>🔥 Moltbook Trending ({len(posts[:max_posts])} new)</b>\n"]
    for i, post in enumerate(posts[:max_posts], 1):
        score = post.get("score", 0)
        title = post.get("title", "Untitled")
        url = post.get("url", "#")
        lines.append(f'{i}. <a href="{url}">{title}</a> — {score}pts')
    return "\n".join(lines)


def send_webhook(url: str, payload: str) -> bool:
    data = json.dumps({"text": payload, "parse": "full"}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except urllib.error.URLError as e:
        print(f"Webhook error: {e}", file=sys.stderr)
        return False


def send_telegram(bot_token: str, chat_id: str, text: str) -> bool:
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    data = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except urllib.error.URLError as e:
        print(f"Telegram error: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--posts", required=True)
    parser.add_argument("--max-posts", type=int, default=10)
    args = parser.parse_args()

    config = load_config(args.config)
    with open(args.posts) as f:
        data = json.load(f)

    posts = data.get("posts", [])
    if not posts:
        print("No posts to push.")
        return

    channels = config.get("notification", {}).get("channels", [])
    for ch in channels:
        if not ch.get("enabled", False):
            continue

        ch_type = ch.get("type")
        fmt = ch.get("format", "markdown")

        if fmt == "markdown":
            message = format_markdown(posts, args.max_posts)
        elif fmt == "html":
            message = format_html(posts, args.max_posts)
        else:
            message = format_markdown(posts, args.max_posts)

        if ch_type == "webhook":
            url = os.environ.get(ch.get("url_env", ""), "")
            if url:
                ok = send_webhook(url, message)
                print(f"Webhook '{ch.get('name')}': {'OK' if ok else 'FAILED'}")

        elif ch_type == "telegram":
            token = os.environ.get(ch.get("bot_token_env", ""), "")
            chat_id = os.environ.get(ch.get("chat_id_env", ""), "")
            if token and chat_id:
                ok = send_telegram(token, chat_id, message)
                print(f"Telegram '{ch.get('name')}': {'OK' if ok else 'FAILED'}")


if __name__ == "__main__":
    main()
