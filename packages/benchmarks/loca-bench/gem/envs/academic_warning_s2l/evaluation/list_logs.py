import subprocess
import sys

from google.cloud import logging
from google.api_core import exceptions

def get_project_id():
    """Get the current Google Cloud project ID from gcloud config."""
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

def list_all_logs_in_bucket(project_id: str, bucket_id: str):
    """
    Lists all log entries that are routed to a specific log bucket
    by querying the log stream with the same name.

    NOTE: This method works because of the 1-to-1 mapping between the log name
    and the bucket name in this project's setup.

    Args:
        project_id: The Google Cloud project ID.
        bucket_id: The ID of the log bucket, which must match the log name.
    """
    # The log's "short name" is the same as our bucket's ID in this case.
    log_name_to_query = bucket_id

    print(f"\n🔍 Searching for logs routed to bucket '{bucket_id}' (by querying log name: '{log_name_to_query}')...")

    try:
        client = logging.Client(project=project_id)

        # FIX: The correct, indexable field is `logName`.
        # Its format is `projects/PROJECT_ID/logs/LOG_NAME`.
        full_log_name = f"projects/{project_id}/logs/{log_name_to_query}"
        log_filter = f'logName="{full_log_name}"'
        
        print(f"   Using filter: {log_filter}")
        print("-" * 60)

        entries_pager = client.list_entries(
            filter_=log_filter, 
            order_by=logging.DESCENDING  # Show newest first
        )

        entry_found = False
        for entry in entries_pager:
            entry_found = True
            timestamp = entry.timestamp.strftime("%Y-%m-%d %H:%M:%S UTC")
            severity = entry.severity or "DEFAULT"
            payload = entry.payload if entry.payload else "No payload"

            print(f"[{timestamp}] [{severity}]")
            
            if isinstance(payload, dict):
                # Pretty-print dictionary payloads
                for key, value in payload.items():
                    print(f"  - {key}: {value}")
            else:
                print(f"  Payload: {payload}")
            
            print("-" * 20)
        
        if not entry_found:
            print("\n✅ Query successful, but no log entries were found with this log name.")

    except Exception as e:
        print(f"❌ An unexpected error occurred: {e}")


if __name__ == "__main__":
    project_id = get_project_id()
    # In our setup, the bucket ID and the log name are the same.
    bucket_id_to_query = "exam_log" 

    print("=" * 60)
    print(f"Listing all logs for project: '{project_id}'")
    
    list_all_logs_in_bucket(project_id, bucket_id_to_query)
    
    print("=" * 60)
    print("Script finished.")