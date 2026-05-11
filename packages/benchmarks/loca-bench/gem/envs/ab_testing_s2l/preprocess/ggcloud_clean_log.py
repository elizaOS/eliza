from google.cloud import logging
from google.cloud.logging_v2.services import config_service_v2
from google.cloud.logging_v2.types import LogBucket
from google.cloud.exceptions import NotFound
from google.api_core import exceptions
import sys
import subprocess
from datetime import datetime, timedelta


def get_project_id():
    """Get the current Google Cloud project ID"""
    try:
        project_id = subprocess.check_output(
            ["gcloud", "config", "get-value", "project"],
            text=True
        ).strip()
        if not project_id or project_id == "(unset)":
            raise ValueError("No project ID configured")
        return project_id
    except Exception as e:
        print(f"❌ Failed to get project ID: {e}")
        print("Run: gcloud config set project YOUR_PROJECT_ID")
        sys.exit(1)


def list_log_buckets(project_id: str, credentials=None):
    """List all log buckets in the project"""
    try:
        client = config_service_v2.ConfigServiceV2Client(credentials=credentials)
        # Use '-' wildcard to list buckets from all locations
        parent = f"projects/{project_id}/locations/-"

        print(f"Listing log buckets for project '{project_id}'...")
        buckets_pager = client.list_buckets(parent=parent)

        bucket_found = False
        for bucket in buckets_pager:
            bucket_found = True
            bucket_id = bucket.name.split('/')[-1]
            location = bucket.name.split('/')[-3]
            print(f"  - {bucket_id} (location: {location}, retention: {bucket.retention_days} days)")

        if not bucket_found:
            print("No log buckets found in this project")

    except Exception as e:
        print(f"❌ Failed to list log buckets: {e}")


def check_log_bucket_exists(project_id: str, bucket_name: str, credentials=None) -> bool:
    """Check if a log bucket exists"""
    try:
        client = config_service_v2.ConfigServiceV2Client(credentials=credentials)
        # NOTE: Buckets are regional. Assuming 'global' for this check.
        parent = f"projects/{project_id}/locations/global"
        bucket_resource_name = f"{parent}/buckets/{bucket_name}"

        # FIX: Call the method with a 'request' dictionary.
        client.get_bucket(request={"name": bucket_resource_name})
        return True
    except exceptions.NotFound:
        return False
    except Exception as e:
        print(f"Error checking log bucket: {e}")
        return False


def delete_log_bucket_if_exists(project_id: str, bucket_name: str, credentials=None) -> bool:
    """Delete log bucket if it exists"""
    try:
        client = config_service_v2.ConfigServiceV2Client(credentials=credentials)
        parent = f"projects/{project_id}/locations/global"
        bucket_resource_name = f"{parent}/buckets/{bucket_name}"

        # FIX: Call the method with a 'request' dictionary.
        client.delete_bucket(request={"name": bucket_resource_name})
        print(f"✅ Log bucket '{bucket_name}' deleted successfully")
        return True

    except exceptions.NotFound:
        print(f"✅ Log bucket '{bucket_name}' didn't exist, nothing to delete.")
        return True
    except Exception as e:
        print(f"❌ Failed to delete log bucket: {e}")
        return False


def create_log_bucket(
    project_id: str,
    bucket_name: str,
    retention_days: int = 30,
    description: str = None,
    credentials=None
) -> bool:
    """Create a new log bucket"""
    try:
        client = config_service_v2.ConfigServiceV2Client(credentials=credentials)
        parent = f"projects/{project_id}/locations/global"

        # Create bucket configuration
        bucket_config = LogBucket(
            retention_days=retention_days,
            description=description or f"Log bucket for {bucket_name}"
        )

        # FIX: Call the method with a 'request' dictionary.
        request = {
            "parent": parent,
            "bucket_id": bucket_name,
            "bucket": bucket_config
        }
        client.create_bucket(request)

        print(f"✅ Log bucket '{bucket_name}' created successfully")
        return True

    except exceptions.AlreadyExists:
        print(f"ℹ️  Log bucket '{bucket_name}' already exists")
        return True
    except Exception as e:
        print(f"❌ Failed to create log bucket: {e}")
        return False


def clear_log_entries(project_id: str, log_name: str, credentials=None) -> bool:
    """Clear all log entries from a specific log"""
    try:
        client = logging.Client(project=project_id, credentials=credentials)
        
        # Get the logger object for the specific log
        logger = client.logger(log_name)
        
        # Delete the log (this removes all entries but keeps the bucket)
        logger.delete()
        
        print(f"✅ All log entries cleared from '{log_name}'")
        return True
        
    except NotFound:
        print(f"ℹ️  No log entries found in '{log_name}' (or log doesn't exist)")
        return True
    except Exception as e:
        print(f"❌ Failed to clear log entries: {e}")
        return False


def manage_log_bucket(
    project_id: str,
    bucket_name: str,
    clear_logs_if_exists: bool = True,
    retention_days: int = 30,
    description: str = None,
    credentials=None
) -> bool:
    """
    Manage log bucket: check if exists, clear logs if requested, create if doesn't exist
    """
    try:
        # Check if bucket exists
        exists = check_log_bucket_exists(project_id, bucket_name, credentials)

        if exists:
            print(f"✅ Log bucket '{bucket_name}' exists")

            if clear_logs_if_exists:
                print(f"🧹 Clearing all log entries from bucket '{bucket_name}'...")
                if not clear_log_entries(project_id, bucket_name, credentials):
                    return False
            else:
                print(f"ℹ️  Keeping existing bucket and logs as requested.")
                return True
        else:
            print(f"ℹ️  Log bucket '{bucket_name}' does not exist")
            # Create new bucket
            print(f"🔨 Creating log bucket '{bucket_name}'...")
            return create_log_bucket(project_id, bucket_name, retention_days, description, credentials)

        return True

    except Exception as e:
        print(f"❌ Error managing log bucket: {e}")
        return False


def setup_abtesting_log_bucket(project_id: str, credentials=None) -> bool:
    """Specific setup for abtesting_logging bucket used in ab-testing task"""

    success = manage_log_bucket(
        project_id=project_id,
        bucket_name="abtesting_logging",
        clear_logs_if_exists=True,
        retention_days=30,
        description="Log bucket for A/B testing system logs",
        credentials=credentials
    )

    if success:
        print(f"🎯 A/B testing log bucket ready for ab-testing task")
        return True
    else:
        print("❌ Failed to setup abtesting log bucket")
        return False


def write_test_log_entry(project_id: str, log_name: str = "exam_log", credentials=None) -> bool:
    """Write a test log entry to verify the setup"""
    try:
        client = logging.Client(project=project_id, credentials=credentials)
        # By default, logs written to a logger with a name that matches a bucket ID
        # are routed to that bucket.
        logger = client.logger(log_name)

        test_message = f"Test log entry created at {datetime.utcnow().isoformat()}Z"
        logger.log_text(test_message, severity="INFO")

        print(f"✅ Test entry written to log '{log_name}'")
        return True

    except Exception as e:
        print(f"❌ Failed to write test log entry: {e}")
        return False


def read_recent_log_entries(project_id: str, log_name: str, max_entries: int = 10, credentials=None):
    """Read recent entries from a specific log"""
    try:
        client = logging.Client(project=project_id, credentials=credentials)
        log_filter = f'logName="projects/{project_id}/logs/{log_name}"'

        entries = list(client.list_entries(
            filter_=log_filter,
            order_by=logging.DESCENDING,
            page_size=max_entries # Use page_size for better control
        ))

        if not entries:
            print(f"No entries found in log '{log_name}'")
        else:
            print(f"Recent entries from log '{log_name}':")
            for i, entry in enumerate(entries[:max_entries], 1):
                timestamp = entry.timestamp.strftime("%Y-%m-%d %H:%M:%S UTC")
                severity = entry.severity or "INFO"
                payload = entry.payload
                print(f"  {i}. [{timestamp}] {severity}: {payload}")

    except Exception as e:
        print(f"❌ Failed to read log entries: {e}")


def clean_log(project_id: str, credentials=None):
    """Main function to clean and setup abtesting_logging bucket"""
    print("=" * 60)
    print("Cloud Logging Management for A/B Testing Task")
    print("=" * 60)

    # Manage abtesting_logging bucket (delete if exists, then create new)
    print("\n1. Setting up clean abtesting_logging bucket...")
    success = setup_abtesting_log_bucket(project_id, credentials)

    if success:
        # Write a test entry to verify
        print("\n2. Writing test entry to verify setup...")
        write_test_log_entry(project_id, "abtesting_logging", credentials)

    # List all log buckets to verify
    print("\n3. Listing all log buckets...")
    list_log_buckets(project_id, credentials)

    print("\n✅ Log bucket management complete!")
    return success


if __name__ == "__main__":
    project_id = get_project_id()
    print(f"Using project: {project_id}")

    clean_log(project_id)

    print("\nReady to write CRITICAL-level academic warning logs to 'exam_log'.")
    