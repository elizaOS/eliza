from google.cloud import bigquery
from google.cloud.exceptions import NotFound, Conflict
import sys
import subprocess


def manage_bigquery_dataset(
    project_id: str,
    dataset_id: str,
    location: str = "US",
    description: str = None,
    delete_if_exists: bool = True,
    credentials=None
):
    """
    Check if BigQuery dataset exists, optionally delete and recreate it
    
    Args:
        project_id: Google Cloud project ID
        dataset_id: BigQuery dataset ID
        location: Dataset location (default: "US")
        description: Optional dataset description
        delete_if_exists: If True, delete existing dataset before creating new one
        credentials: Google Cloud credentials
    
    Returns:
        bigquery.Dataset: The created dataset object
    """
    
    # Initialize BigQuery client
    try:
        client = bigquery.Client(project=project_id, credentials=credentials)
        print(f"Connected to project: {project_id}")
    except Exception as e:
        print(f"L Failed to initialize BigQuery client: {e}")
        print("Make sure you're authenticated: gcloud auth application-default login")
        sys.exit(1)
    
    # Get dataset reference
    dataset_ref = client.dataset(dataset_id)
    
    # Check if dataset exists
    try:
        existing_dataset = client.get_dataset(dataset_ref)
        print(f"✅ Dataset '{dataset_id}' exists")
        
        if delete_if_exists:
            print(f"=✅  Deleting existing dataset '{dataset_id}' and all its tables...")
            try:
                # Delete dataset and all tables
                client.delete_dataset(dataset_ref, delete_contents=True, not_found_ok=True)
                print(f"✅ Dataset '{dataset_id}' deleted successfully")
            except Exception as e:
                print(f"L Failed to delete dataset: {e}")
                return None
        else:
            print(f"9  Dataset '{dataset_id}' already exists, skipping creation")
            return existing_dataset
            
    except NotFound:
        print(f"9  Dataset '{dataset_id}' does not exist")
    except Exception as e:
        print(f"L Error checking dataset: {e}")
        return None
    
    # Create new dataset
    print(f"=( Creating new dataset '{dataset_id}'...")
    try:
        dataset = bigquery.Dataset(dataset_ref)
        dataset.location = location
        if description:
            dataset.description = description
            
        # Set default table expiration (optional - 30 days)
        # dataset.default_table_expiration_ms = 1000 * 60 * 60 * 24 * 30
        
        created_dataset = client.create_dataset(dataset, exists_ok=False)
        print(f"✅ Dataset '{dataset_id}' created successfully in {location}")
        return created_dataset
        
    except Conflict:
        print(f"✅  Dataset '{dataset_id}' already exists (race condition)")
        return client.get_dataset(dataset_ref)
    except Exception as e:
        print(f"L Failed to create dataset: {e}")
        return None

def check_dataset_exists(project_id: str, dataset_id: str, credentials=None) -> bool:
    """
    Simple function to check if a dataset exists
    
    Returns:
        bool: True if dataset exists, False otherwise
    """
    try:
        client = bigquery.Client(project=project_id, credentials=credentials)
        dataset_ref = client.dataset(dataset_id)
        client.get_dataset(dataset_ref)
        return True
    except NotFound:
        return False
    except Exception as e:
        print(f"Error checking dataset: {e}")
        return False

def delete_dataset_if_exists(project_id: str, dataset_id: str, credentials=None) -> bool:
    """
    Delete dataset if it exists
    
    Returns:
        bool: True if deleted or didn't exist, False if error
    """
    try:
        client = bigquery.Client(project=project_id, credentials=credentials)
        dataset_ref = client.dataset(dataset_id)
        
        # Delete with all contents
        client.delete_dataset(dataset_ref, delete_contents=True, not_found_ok=True)
        print(f"✅ Dataset '{dataset_id}' deleted (or didn't exist)")
        return True
        
    except Exception as e:
        print(f"L Failed to delete dataset: {e}")
        return False

def create_empty_dataset(
    project_id: str, 
    dataset_id: str, 
    location: str = "US",
    description: str = None,
    credentials=None
) -> bigquery.Dataset:
    """
    Create a new empty dataset
    
    Returns:
        bigquery.Dataset: Created dataset or None if failed
    """
    try:
        client = bigquery.Client(project=project_id, credentials=credentials)
        dataset_ref = client.dataset(dataset_id)
        
        dataset = bigquery.Dataset(dataset_ref)
        dataset.location = location
        if description:
            dataset.description = description
            
        created_dataset = client.create_dataset(dataset, exists_ok=False)
        print(f"✅ Empty dataset '{dataset_id}' created in {location}")
        return created_dataset
        
    except Conflict:
        print(f"✅  Dataset '{dataset_id}' already exists")
        return client.get_dataset(dataset_ref)
    except Exception as e:
        print(f"L Failed to create dataset: {e}")
        return None

def list_all_datasets(project_id: str, credentials=None):
    """List all datasets in the project"""
    try:
        client = bigquery.Client(project=project_id, credentials=credentials)
        datasets = list(client.list_datasets())
        
        if not datasets:
            print("No datasets found in project")
        else:
            print(f"Datasets in project '{project_id}':")
            for dataset in datasets:
                print(f"  - {dataset.dataset_id}")
                
    except Exception as e:
        print(f"L Failed to list datasets: {e}")

def setup_academic_warning_dataset(project_id: str, credentials=None):
    """Specific setup for academic-warning task"""
    
    dataset = manage_bigquery_dataset(
        project_id=project_id,
        dataset_id="academic_warning",
        location="US",
        description="Academic warning system dataset for student performance analysis",
        delete_if_exists=True,
        credentials=credentials
    )
    
    if dataset:
        print(f"<✅ Academic warning dataset ready: {dataset.dataset_id}")
        return dataset
    else:
        print("L Failed to setup academic warning dataset")
        return None

def clean_dataset(project_id, credentials=None):
    # Check if dataset exists
    print("\n1. Checking if dataset exists...")
    exists = check_dataset_exists(project_id, "academic_warning", credentials)
    print(f"Dataset 'academic_warning' exists: {exists}")
    
    # Manage dataset (delete if exists, then create new)
    print("\n2. Setting up clean academic_warning dataset...")
    dataset = setup_academic_warning_dataset(project_id, credentials)
    
    # List all datasets to verify
    print("\n3. Listing all datasets...")
    list_all_datasets(project_id, credentials)
    
    print("\n✅ Dataset management complete!")
    print(f"Ready to populate dataset '{dataset.dataset_id}' with exam tables.")