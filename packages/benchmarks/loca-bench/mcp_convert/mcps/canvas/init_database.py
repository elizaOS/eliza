"""
Canvas Database Initialization Script

Initializes the Canvas database with default users, accounts, and empty data files.
"""

import json
import os
from datetime import datetime, timezone
from typing import Dict, Any


def create_default_users() -> Dict[str, Any]:
    """Create default users (1 admin, 2 teachers, 5 students)"""
    now = datetime.now(timezone.utc).isoformat()

    users = {
        # Admin
        "1": {
            "id": 1,
            "name": "Jennifer Martinez",
            "short_name": "Jennifer",
            "sortable_name": "Martinez, Jennifer",
            "login_id": "admin",
            "password": "admin123",
            "primary_email": "jennifer.martinez@canvas.edu",
            "time_zone": "America/Denver",
            "created_at": now,
            "updated_at": now
        },
        # Teachers
        "2": {
            "id": 2,
            "name": "Dr. Robert Chen",
            "short_name": "Robert",
            "sortable_name": "Chen, Robert",
            "login_id": "robert.chen",
            "password": "teacher123",
            "primary_email": "robert.chen@canvas.edu",
            "time_zone": "America/Denver",
            "created_at": now,
            "updated_at": now
        },
        "3": {
            "id": 3,
            "name": "Prof. Sarah Johnson",
            "short_name": "Sarah",
            "sortable_name": "Johnson, Sarah",
            "login_id": "sarah.johnson",
            "password": "teacher123",
            "primary_email": "sarah.johnson@canvas.edu",
            "time_zone": "America/New_York",
            "created_at": now,
            "updated_at": now
        },
        # Students
        "4": {
            "id": 4,
            "name": "Michael Thompson",
            "short_name": "Michael",
            "sortable_name": "Thompson, Michael",
            "login_id": "michael.thompson",
            "password": "student123",
            "primary_email": "michael.thompson@student.canvas.edu",
            "time_zone": "America/Denver",
            "created_at": now,
            "updated_at": now
        },
        "5": {
            "id": 5,
            "name": "Emily Rodriguez",
            "short_name": "Emily",
            "sortable_name": "Rodriguez, Emily",
            "login_id": "emily.rodriguez",
            "password": "student123",
            "primary_email": "emily.rodriguez@student.canvas.edu",
            "time_zone": "America/Chicago",
            "created_at": now,
            "updated_at": now
        },
        "6": {
            "id": 6,
            "name": "James Wilson",
            "short_name": "James",
            "sortable_name": "Wilson, James",
            "login_id": "james.wilson",
            "password": "student123",
            "primary_email": "james.wilson@student.canvas.edu",
            "time_zone": "America/Los_Angeles",
            "created_at": now,
            "updated_at": now
        },
        "7": {
            "id": 7,
            "name": "Sophia Patel",
            "short_name": "Sophia",
            "sortable_name": "Patel, Sophia",
            "login_id": "sophia.patel",
            "password": "student123",
            "primary_email": "sophia.patel@student.canvas.edu",
            "time_zone": "America/New_York",
            "created_at": now,
            "updated_at": now
        },
        "8": {
            "id": 8,
            "name": "Daniel Kim",
            "short_name": "Daniel",
            "sortable_name": "Kim, Daniel",
            "login_id": "daniel.kim",
            "password": "student123",
            "primary_email": "daniel.kim@student.canvas.edu",
            "time_zone": "America/Denver",
            "created_at": now,
            "updated_at": now
        }
    }

    return users


def create_default_accounts() -> Dict[str, Any]:
    """Create default accounts"""
    accounts = {
        "1": {
            "id": 1,
            "name": "Default Institution",
            "uuid": "account-uuid-1",
            "parent_account_id": None,
            "root_account_id": 1,
            "default_storage_quota_mb": 500,
            "default_user_storage_quota_mb": 50,
            "default_group_storage_quota_mb": 50,
            "default_time_zone": "America/Denver",
            "sis_account_id": "DEFAULT-INST-001",
            "integration_id": None,
            "sis_import_id": None,
            "lti_guid": "account-lti-guid-1",
            "workflow_state": "active"
        }
    }

    return accounts


def create_empty_courses() -> Dict[str, Any]:
    """Create empty courses dictionary"""
    return {}


def create_empty_assignments() -> Dict[str, Any]:
    """Create empty assignments dictionary"""
    return {}


def create_empty_enrollments() -> Dict[str, Any]:
    """Create empty enrollments dictionary"""
    return {}


def create_empty_submissions() -> Dict[str, Any]:
    """Create empty submissions dictionary"""
    return {}


def create_empty_files() -> Dict[str, Any]:
    """Create empty files dictionary"""
    return {}


def create_empty_folders() -> Dict[str, Any]:
    """Create empty folders dictionary"""
    return {}


def create_empty_pages() -> Dict[str, Any]:
    """Create empty pages dictionary"""
    return {}


def create_empty_modules() -> Dict[str, Any]:
    """Create empty modules dictionary"""
    return {}


def create_empty_module_items() -> Dict[str, Any]:
    """Create empty module items dictionary"""
    return {}


def create_empty_discussions() -> Dict[str, Any]:
    """Create empty discussions dictionary"""
    return {}


def create_empty_announcements() -> Dict[str, Any]:
    """Create empty announcements dictionary"""
    return {}


def create_empty_quizzes() -> Dict[str, Any]:
    """Create empty quizzes dictionary"""
    return {}


def create_empty_rubrics() -> Dict[str, Any]:
    """Create empty rubrics dictionary"""
    return {}


def create_empty_conversations() -> Dict[str, Any]:
    """Create empty conversations dictionary"""
    return {}


def create_empty_notifications() -> Dict[str, Any]:
    """Create empty notifications dictionary"""
    return {}


def create_empty_calendar_events() -> Dict[str, Any]:
    """Create empty calendar events dictionary"""
    return {}


def create_empty_grades() -> Dict[str, Any]:
    """Create empty grades dictionary"""
    return {}


def initialize_database(data_dir: str, verbose: bool = True):
    """
    Initialize the Canvas database with default data.

    Args:
        data_dir: Directory where database files will be stored
        verbose: Print progress messages
    """
    # Create data directory if it doesn't exist
    os.makedirs(data_dir, exist_ok=True)

    if verbose:
        print(f"Initializing Canvas database in: {data_dir}")

    # Define all data files and their initialization functions
    data_files = {
        "users.json": create_default_users,
        "accounts.json": create_default_accounts,
        "courses.json": create_empty_courses,
        "assignments.json": create_empty_assignments,
        "enrollments.json": create_empty_enrollments,
        "submissions.json": create_empty_submissions,
        "files.json": create_empty_files,
        "folders.json": create_empty_folders,
        "pages.json": create_empty_pages,
        "modules.json": create_empty_modules,
        "module_items.json": create_empty_module_items,
        "discussions.json": create_empty_discussions,
        "announcements.json": create_empty_announcements,
        "quizzes.json": create_empty_quizzes,
        "rubrics.json": create_empty_rubrics,
        "conversations.json": create_empty_conversations,
        "notifications.json": create_empty_notifications,
        "calendar_events.json": create_empty_calendar_events,
        "grades.json": create_empty_grades,
    }

    # Create each data file
    for filename, init_func in data_files.items():
        filepath = os.path.join(data_dir, filename)
        data = init_func()

        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)

        if verbose:
            print(f"  Created {filename}")

    if verbose:
        print("\nDatabase initialization complete!")
        print("\nDefault users created:")
        print("  Administrator:")
        print("    - Jennifer Martinez (login='admin', password='admin123')")
        print("\n  Teachers:")
        print("    - Dr. Robert Chen (login='robert.chen', password='teacher123')")
        print("    - Prof. Sarah Johnson (login='sarah.johnson', password='teacher123')")
        print("\n  Students:")
        print("    - Michael Thompson (login='michael.thompson', password='student123')")
        print("    - Emily Rodriguez (login='emily.rodriguez', password='student123')")
        print("    - James Wilson (login='james.wilson', password='student123')")
        print("    - Sophia Patel (login='sophia.patel', password='student123')")
        print("    - Daniel Kim (login='daniel.kim', password='student123')")
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

    # Check for essential files
    essential_files = ["users.json", "accounts.json", "courses.json"]

    for filename in essential_files:
        filepath = os.path.join(data_dir, filename)
        if not os.path.exists(filepath):
            return False

        # Check if file has content
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
                # For users and accounts, check they have data
                if filename in ["users.json", "accounts.json"]:
                    if not data:
                        return False
        except (json.JSONDecodeError, IOError):
            return False

    return True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Initialize Canvas database")
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