"""
Calendar Database Initialization Script

Initializes the Calendar database with an empty events file or sample events.
"""

import json
import os
from datetime import datetime, timezone
from typing import Dict, Any, List


def create_sample_events() -> List[Dict[str, Any]]:
    """Create sample calendar events for demonstration"""
    return [
        {
            "id": "event_001",
            "summary": "Team Standup Meeting",
            "description": "Daily standup with the engineering team",
            "location": "Conference Room A",
            "start": {
                "dateTime": "2025-10-29T09:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "end": {
                "dateTime": "2025-10-29T09:30:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "created": "2025-10-20T10:00:00Z",
            "updated": "2025-10-20T10:00:00Z",
            "creator": {
                "email": "manager@example.com",
                "displayName": "Team Manager"
            },
            "organizer": {
                "email": "manager@example.com",
                "displayName": "Team Manager"
            },
            "status": "confirmed",
            "attendees": [
                {
                    "email": "dev1@example.com",
                    "displayName": "Developer One",
                    "responseStatus": "accepted"
                },
                {
                    "email": "dev2@example.com",
                    "displayName": "Developer Two",
                    "responseStatus": "accepted"
                }
            ]
        },
        {
            "id": "event_002",
            "summary": "Project Planning Session",
            "description": "Q4 project planning and roadmap discussion",
            "location": "Zoom Meeting",
            "start": {
                "dateTime": "2025-10-30T14:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "end": {
                "dateTime": "2025-10-30T16:00:00-07:00",
                "timeZone": "America/Los_Angeles"
            },
            "created": "2025-10-15T08:00:00Z",
            "updated": "2025-10-25T12:00:00Z",
            "creator": {
                "email": "pm@example.com",
                "displayName": "Product Manager"
            },
            "organizer": {
                "email": "pm@example.com",
                "displayName": "Product Manager"
            },
            "status": "confirmed",
            "attendees": [
                {
                    "email": "team@example.com",
                    "displayName": "Engineering Team",
                    "responseStatus": "needsAction"
                }
            ]
        }
    ]


def initialize_database(data_dir: str, verbose: bool = False, with_samples: bool = False):
    """
    Initialize the Calendar database.

    Args:
        data_dir: Directory where database files will be stored
        verbose: Print progress messages
        with_samples: Include sample events (default: empty)
    """
    # Create data directory if it doesn't exist
    os.makedirs(data_dir, exist_ok=True)

    if verbose:
        print(f"Initializing Calendar database in: {data_dir}")

    # Create events.json
    if with_samples:
        events = create_sample_events()
        if verbose:
            print(f"  Created events.json with {len(events)} sample events")
    else:
        events = []
        if verbose:
            print("  Created events.json (empty)")

    events_file = os.path.join(data_dir, "events.json")
    with open(events_file, 'w') as f:
        json.dump(events, f, indent=2)

    if verbose:
        print("\nDatabase initialization complete!")
        if with_samples:
            print("\nSample events created:")
            for event in events:
                print(f"  - {event['summary']} ({event['id']})")
        else:
            print("\nEmpty calendar ready for use.")


def check_database_initialized(data_dir: str) -> bool:
    """
    Check if the database has been initialized.

    Args:
        data_dir: Directory where database files should be stored

    Returns:
        True if database appears to be initialized, False otherwise
    """
    if not os.path.exists(data_dir):
        return False

    # Check for events.json
    events_file = os.path.join(data_dir, "events.json")
    if not os.path.exists(events_file):
        return False

    # Check if events.json is valid JSON
    try:
        with open(events_file, 'r') as f:
            events = json.load(f)
            # Must be a list (can be empty)
            if not isinstance(events, list):
                return False
    except (json.JSONDecodeError, IOError):
        return False

    return True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Initialize Calendar database")
    parser.add_argument(
        "--data-dir",
        type=str,
        default="./data",
        help="Directory where database files will be stored"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-initialization even if database already exists"
    )
    parser.add_argument(
        "--with-samples",
        action="store_true",
        help="Initialize with sample events instead of empty"
    )

    args = parser.parse_args()

    # Check if already initialized
    if not args.force and check_database_initialized(args.data_dir):
        print(f"Database already initialized in {args.data_dir}")
        print("Use --force to re-initialize")
    else:
        initialize_database(args.data_dir, verbose=True, with_samples=args.with_samples)
