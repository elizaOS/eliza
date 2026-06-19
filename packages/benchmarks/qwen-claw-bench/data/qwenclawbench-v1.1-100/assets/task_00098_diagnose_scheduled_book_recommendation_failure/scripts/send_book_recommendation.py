#!/usr/bin/env python3
"""
Daily Book Recommendation Sender

Selects a book from the database that hasn't been recommended recently
and sends it to the configured messaging channel.

Usage:
    python send_book_recommendation.py [--dry-run] [--channel telegram]
"""

import json
import sys
import os
import random
import logging
from datetime import datetime, timedelta
from pathlib import Path

# Setup logging
LOG_DIR = Path(__file__).parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "book_recommendation.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("book_recommender")

BOOKS_PATH = Path(__file__).parent.parent / "data" / "books.json"
TEMPLATE_PATH = Path(__file__).parent.parent / "templates" / "book_recommendation.md"
HISTORY_PATH = Path(__file__).parent.parent / "data" / "recommendation_history.json"


def load_books():
    """Load books database."""
    with open(BOOKS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_template():
    """Load message template."""
    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        return f.read()


def select_book(books, cooldown_days=7):
    """Select a book that hasn't been recommended within the cooldown period."""
    now = datetime.utcnow()
    eligible = []

    for book in books:
        last_rec = book.get("last_recommended")
        if last_rec is None:
            eligible.append(book)
        else:
            last_date = datetime.strptime(last_rec, "%Y-%m-%d")
            if (now - last_date).days >= cooldown_days:
                eligible.append(book)

    if not eligible:
        logger.warning("No eligible books found, resetting cooldown to all books")
        eligible = books

    selected = random.choice(eligible)
    logger.info(f"Selected book: {selected['title']} by {selected['author']}")
    return selected


def format_message(book, template):
    """Format the recommendation message using the template."""
    stars = "★" * int(book["rating"]) + "☆" * (5 - int(book["rating"]))
    return template.format(
        title=book["title"],
        author=book["author"],
        genre=book["genre"],
        rating=book["rating"],
        stars=stars,
        description=book["description"],
        date=datetime.utcnow().strftime("%Y-%m-%d"),
    )


def update_history(book):
    """Record recommendation in history."""
    history = []
    if HISTORY_PATH.exists():
        with open(HISTORY_PATH, "r") as f:
            history = json.load(f)

    history.append({
        "book_id": book["id"],
        "title": book["title"],
        "recommended_at": datetime.utcnow().isoformat(),
    })

    with open(HISTORY_PATH, "w") as f:
        json.dump(history, f, indent=2)

    # Also update the book's last_recommended in the main DB
    books = load_books()
    for b in books:
        if b["id"] == book["id"]:
            b["last_recommended"] = datetime.utcnow().strftime("%Y-%m-%d")
            break
    with open(BOOKS_PATH, "w") as f:
        json.dump(books, f, indent=2)

    logger.info(f"Updated recommendation history for book_id={book['id']}")


def send_message(message, channel="telegram", dry_run=False):
    """Send message via messaging service.

    In production, this calls the OpenClaw message tool or Telegram API.
    For local testing, prints to stdout.
    """
    if dry_run:
        logger.info("[DRY RUN] Would send message:")
        print(message)
        return True

    # Production: use OpenClaw cron/message integration
    # This script is typically invoked by the OpenClaw cron scheduler
    # which handles message delivery via the configured channel
    print(message)
    return True


def main():
    dry_run = "--dry-run" in sys.argv
    channel = "telegram"
    for i, arg in enumerate(sys.argv):
        if arg == "--channel" and i + 1 < len(sys.argv):
            channel = sys.argv[i + 1]

    logger.info(f"Starting daily book recommendation (channel={channel}, dry_run={dry_run})")

    try:
        books = load_books()
        logger.info(f"Loaded {len(books)} books from database")

        template = load_template()
        book = select_book(books)
        message = format_message(book, template)

        success = send_message(message, channel=channel, dry_run=dry_run)
        if success:
            if not dry_run:
                update_history(book)
            logger.info("Book recommendation sent successfully")
            return 0
        else:
            logger.error("Failed to send book recommendation")
            return 1

    except FileNotFoundError as e:
        logger.error(f"Required file not found: {e}")
        return 2
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in data file: {e}")
        return 3
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return 99


if __name__ == "__main__":
    sys.exit(main())
