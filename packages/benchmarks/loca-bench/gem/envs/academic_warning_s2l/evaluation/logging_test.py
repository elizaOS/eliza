# logging_test.py
import subprocess
import sys
import uuid
from datetime import datetime, UTC  # Import UTC
from time import sleep

from google.cloud import logging
from google.cloud.exceptions import NotFound


def get_project_id():
    """Get the current Google Cloud project ID"""
    try:
        project_id = subprocess.check_output(
            ["gcloud", "config", "get-value", "project"], text=True
        ).strip()
        if not project_id or project_id == "(unset)":
            raise ValueError("No project ID configured")
        return project_id
    except Exception as e:
        print(f"❌ Failed to get project ID: {e}")
        print("Please run: gcloud config set project YOUR_PROJECT_ID")
        sys.exit(1)


def write_unique_log_entry(project_id: str, log_name: str, test_uuid: str) -> bool:
    """Writes a unique log entry with a UUID to a specific log."""
    try:
        client = logging.Client(project=project_id)
        logger = client.logger(log_name)

        payload = {
            "message": "This is a unique test log entry for verification.",
            "test_id": test_uuid,
            # FIX 2: Use timezone-aware datetime.now(UTC)
            "timestamp": datetime.now(UTC).isoformat(),
        }

        # FIX 1: Use the correct method log_struct() instead of log_json()
        logger.log_struct(payload, severity="WARNING")

        print(f"✅ Successfully wrote unique log entry to '{log_name}'.")
        print(f"   Test ID: {test_uuid}")
        return True

    except Exception as e:
        print(f"❌ Failed to write log entry: {e}")
        return False


def verify_log_entry(project_id: str, log_name: str, test_uuid: str) -> bool:
    """Reads recent log entries and looks for the unique test entry."""
    print("\nAttempting to read and verify the log entry...")
    try:
        client = logging.Client(project=project_id)
        
        # Construct a precise filter to find the unique log entry
        log_filter = f"""
        logName="projects/{project_id}/logs/{log_name}"
        jsonPayload.test_id="{test_uuid}"
        """

        print(f"Using filter: {log_filter.strip()}")

        # List entries using the filter
        entries = list(client.list_entries(filter_=log_filter, page_size=1))

        if not entries:
            print(f"❌ VERIFICATION FAILED: Could not find the test log entry with ID '{test_uuid}'.")
            print("   Common reasons include:")
            print("   1. Ingestion delay (might need to wait longer).")
            print("   2. Insufficient IAM permissions (requires 'Logs Viewer' role).")
            print("   3. Custom log routing (sinks) sending logs elsewhere.")
            return False
        else:
            entry = entries[0]
            timestamp = entry.timestamp.strftime("%Y-%m-%d %H:%M:%S UTC")
            payload_id = entry.payload.get("test_id")
            
            print("✅ VERIFICATION SUCCESSFUL! Found the log entry.")
            print(f"   - Timestamp: {timestamp}")
            print(f"   - Severity:  {entry.severity}")
            print(f"   - Payload ID: {payload_id}")
            return True

    except Exception as e:
        print(f"❌ An error occurred while trying to read log entries: {e}")
        return False


if __name__ == "__main__":
    project_id = get_project_id()
    log_name = "exam_log"
    # Generate a unique ID for this specific test run
    test_id = str(uuid.uuid4())

    print("=" * 60)
    print(f"Cloud Logging Write/Read Verification Test on project '{project_id}'")
    print("=" * 60)

    # 1. Write the log entry
    print("\nSTEP 1: Writing a unique log entry...")
    if not write_unique_log_entry(project_id, log_name, test_id):
        print("\nAborting test due to write failure.")
        sys.exit(1)

    # 2. Wait for ingestion
    wait_seconds = 30
    print(f"\nSTEP 2: Waiting for {wait_seconds} seconds to allow for log ingestion...")
    sleep(wait_seconds)

    # 3. Read and verify the log entry
    print("\nSTEP 3: Verifying the log entry...")
    verify_log_entry(project_id, log_name, test_id)

    print("\n" + "=" * 60)
    print("Test complete.")
    print(f"You can also check in the Google Cloud Console (Logs Explorer) with the query:\nlogName=\"projects/{project_id}/logs/exam_log\" AND jsonPayload.test_id=\"{test_id}\"")
    print("=" * 60)