from google.cloud import storage
from google.oauth2 import service_account
from google.api_core import exceptions
from pathlib import Path
import json
import sys

def get_project_id_and_credentials(credentials_file="configs/gcp-service_account.keys.json"):
    """Get project ID and credentials from a service account file."""
    try:
        credentials_path = Path(credentials_file)
        if not credentials_path.is_absolute():
            # If the path is relative, resolve it from the current working directory
            credentials_path = Path.cwd() / credentials_path

        with open(credentials_path, 'r') as f:
            data = json.load(f)
            project_id = data.get("project_id")

        credentials = service_account.Credentials.from_service_account_file(credentials_path)
        return project_id, credentials
    except FileNotFoundError:
        print(f"Error: Credentials file not found at '{credentials_path}'")
        sys.exit(1)
    except Exception as e:
        print(f"Failed to load credentials: {e}")
        sys.exit(1)


def list_storage_buckets(project_id: str, credentials):
    """
    Lists all Cloud Storage buckets in a given Google Cloud project using provided credentials.

    Args:
        project_id: The ID of your Google Cloud project.
        credentials: The service account credentials to use for authentication.
    """
    try:
        # Create a client using the provided project and credentials
        storage_client = storage.Client(project=project_id, credentials=credentials)

        print(f"Listing storage buckets for project '{project_id}'...")
        print("-" * 30)

        # List the buckets
        buckets = storage_client.list_buckets()

        bucket_found = False
        for bucket in buckets:
            bucket_found = True
            print(f"Bucket Name:        {bucket.name}")
            print(f"Location:           {bucket.location}")
            print(f"Storage Class:      {bucket.storage_class}")
            print(f"Created:            {bucket.time_created.strftime('%Y-%m-%d %H:%M:%S') if bucket.time_created else 'N/A'}")
            print("-" * 30)

        if not bucket_found:
            print("No storage buckets found in this project.")

    except exceptions.Forbidden:
        print(f"Error: Permission denied. Ensure the service account has the 'storage.buckets.list' IAM permission for project '{project_id}'.")
    except exceptions.NotFound:
        print(f"Error: Project '{project_id}' not found.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

# --- Example Usage ---
if __name__ == "__main__":
    # Specify the path to your service account JSON file
    # You can also pass this as a command-line argument if you prefer
    credentials_file_path = "configs/gcp-service_account.keys.json"
    
    project_id, credentials = get_project_id_and_credentials(credentials_file_path)
    
    if project_id and credentials:
        list_storage_buckets(project_id, credentials)