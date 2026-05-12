"""
Email Database Initialization Script

Initializes the Email database with default users and their mailbox structures.
"""

import json
import os
from datetime import datetime, timezone
from typing import Dict, Any, List


def create_default_users() -> Dict[str, Any]:
    """Create default email users with realistic names and addresses"""
    now = datetime.now(timezone.utc).isoformat()

    users = {
        # Admin
        "admin@company.com": {
            "email": "admin@company.com",
            "name": "Jennifer Martinez",
            "password": "admin123",
            "created_at": now
        },
        # Employees
        "robert.chen@company.com": {
            "email": "robert.chen@company.com",
            "name": "Dr. Robert Chen",
            "password": "password123",
            "created_at": now
        },
        "sarah.johnson@company.com": {
            "email": "sarah.johnson@company.com",
            "name": "Sarah Johnson",
            "password": "password123",
            "created_at": now
        },
        "michael.thompson@company.com": {
            "email": "michael.thompson@company.com",
            "name": "Michael Thompson",
            "password": "password123",
            "created_at": now
        },
        "emily.rodriguez@company.com": {
            "email": "emily.rodriguez@company.com",
            "name": "Emily Rodriguez",
            "password": "password123",
            "created_at": now
        },
        "james.wilson@company.com": {
            "email": "james.wilson@company.com",
            "name": "James Wilson",
            "password": "password123",
            "created_at": now
        },
        "sophia.patel@company.com": {
            "email": "sophia.patel@company.com",
            "name": "Sophia Patel",
            "password": "password123",
            "created_at": now
        },
        "daniel.kim@company.com": {
            "email": "daniel.kim@company.com",
            "name": "Daniel Kim",
            "password": "password123",
            "created_at": now
        }
    }

    return users


def create_default_folders() -> Dict[str, Any]:
    """Create default email folders for a user"""
    folders = {
        "INBOX": {
            "name": "INBOX",
            "total": 0,
            "unread": 0
        },
        "Sent": {
            "name": "Sent",
            "total": 0,
            "unread": 0
        },
        "Drafts": {
            "name": "Drafts",
            "total": 0,
            "unread": 0
        },
        "Trash": {
            "name": "Trash",
            "total": 0,
            "unread": 0
        },
        "Spam": {
            "name": "Spam",
            "total": 0,
            "unread": 0
        },
        "Archive": {
            "name": "Archive",
            "total": 0,
            "unread": 0
        }
    }
    return folders


def create_empty_emails() -> Dict[str, Any]:
    """Create empty emails dictionary"""
    return {}


def create_empty_drafts() -> Dict[str, Any]:
    """Create empty drafts dictionary"""
    return {}


def initialize_user_mailbox(user_data_dir: str, email: str, verbose: bool = True):
    """
    Initialize a user's mailbox with default folders and empty data.

    Args:
        user_data_dir: Directory where user's data will be stored
        email: User's email address
        verbose: Print progress messages
    """
    os.makedirs(user_data_dir, exist_ok=True)

    # Create user's data files
    user_files = {
        "emails.json": create_empty_emails,
        "folders.json": create_default_folders,
        "drafts.json": create_empty_drafts,
    }

    for filename, init_func in user_files.items():
        filepath = os.path.join(user_data_dir, filename)
        data = init_func()

        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)

    if verbose:
        print(f"  Initialized mailbox for {email}")


def initialize_database(data_dir: str, verbose: bool = True):
    """
    Initialize the Email database with default data.

    Args:
        data_dir: Directory where database files will be stored
        verbose: Print progress messages
    """
    # Create data directory if it doesn't exist
    os.makedirs(data_dir, exist_ok=True)

    if verbose:
        print(f"Initializing Email database in: {data_dir}")

    # Create users.json
    users = create_default_users()
    users_file = os.path.join(data_dir, "users.json")
    with open(users_file, 'w') as f:
        json.dump(users, f, indent=2)

    if verbose:
        print(f"  Created users.json with {len(users)} users")

    # Create per-user data directories
    users_data_dir = os.path.join(data_dir, "users_data")
    os.makedirs(users_data_dir, exist_ok=True)

    for email in users.keys():
        user_data_dir = os.path.join(users_data_dir, email)
        initialize_user_mailbox(user_data_dir, email, verbose=verbose)

    if verbose:
        print("\nDatabase initialization complete!")
        print("\nDefault users created:")
        print("  Administrator:")
        print("    - Jennifer Martinez (admin@company.com, password: admin123)")
        print("\n  Employees:")
        print("    - Dr. Robert Chen (robert.chen@company.com, password: password123)")
        print("    - Sarah Johnson (sarah.johnson@company.com, password: password123)")
        print("    - Michael Thompson (michael.thompson@company.com, password: password123)")
        print("    - Emily Rodriguez (emily.rodriguez@company.com, password: password123)")
        print("    - James Wilson (james.wilson@company.com, password: password123)")
        print("    - Sophia Patel (sophia.patel@company.com, password: password123)")
        print("    - Daniel Kim (daniel.kim@company.com, password: password123)")
        print()


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

    # Check for users.json
    users_file = os.path.join(data_dir, "users.json")
    if not os.path.exists(users_file):
        return False

    # Check if users.json has content
    try:
        with open(users_file, 'r') as f:
            users = json.load(f)
            if not users:
                return False
    except (json.JSONDecodeError, IOError):
        return False

    # Check if users_data directory exists
    users_data_dir = os.path.join(data_dir, "users_data")
    if not os.path.exists(users_data_dir):
        return False

    return True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Initialize Email database")
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

    args = parser.parse_args()

    # Check if already initialized
    if not args.force and check_database_initialized(args.data_dir):
        print(f"Database already initialized in {args.data_dir}")
        print("Use --force to re-initialize")
    else:
        initialize_database(args.data_dir, verbose=True)
