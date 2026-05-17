from google.cloud.logging_v2.services import config_service_v2
from google.api_core import exceptions
from argparse import ArgumentParser
import os
import sys
import subprocess
from pathlib import Path


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
        print(f"L Failed to get project ID: {e}")
        print("Run: gcloud config set project YOUR_PROJECT_ID")
        sys.exit(1)


def list_logging_buckets(project_id: str):
    """
    Lists all Cloud Logging buckets in a given Google Cloud project.

    Args:
        project_id: The ID of your Google Cloud project.
    """
    try:
        client = config_service_v2.ConfigServiceV2Client()

        # --- THIS IS THE LINE TO FIX ---
        parent = f"projects/{project_id}/locations/global"
        # -----------------------------

        print(f"Listing logging buckets for project '{project_id}' in location '-'...")
        print("-" * 30)

        buckets_pager = client.list_buckets(parent=parent)

        bucket_found = False
        for bucket in buckets_pager:
            bucket_found = True
            # Extract the short ID from the full resource name
            bucket_id = bucket.name.split('/')[-1]
            print(f"Bucket ID:          {bucket_id}")
            print(f"Full Resource Name: {bucket.name}")
            print(f"Description:        {bucket.description}")
            print(f"Retention (days):   {bucket.retention_days}")
            print(f"Create Time:        {"None" if bucket.create_time is None else bucket.create_time.strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"Locked:             {'Yes' if bucket.locked else 'No'}")
            print("-" * 30)

        if not bucket_found:
            print("No custom logging buckets found in this project.")
            print("Note: The '_Default' and '_Required' buckets are often listed by this API.")


    except exceptions.PermissionDenied:
        print(f"Error: Permission denied. Ensure you have the 'logging.buckets.list' IAM permission for project '{project_id}'.")
    except exceptions.NotFound:
        print(f"Error: Project '{project_id}' not found or the Cloud Logging API is not enabled.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

# --- Example Usage ---
if __name__ == "__main__":
    # Replace with your actual Google Cloud project ID
    my_project_id = get_project_id()
    list_logging_buckets(my_project_id)