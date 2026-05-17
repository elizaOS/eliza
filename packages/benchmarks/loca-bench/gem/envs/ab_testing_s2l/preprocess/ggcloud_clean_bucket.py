from google.cloud import storage
from google.cloud.exceptions import NotFound
import sys


def check_storage_bucket_exists(project_id: str, bucket_name: str, credentials=None) -> bool:
    """Check if a storage bucket exists"""
    try:
        client = storage.Client(project=project_id, credentials=credentials)
        client.get_bucket(bucket_name)
        return True
    except NotFound:
        return False
    except Exception as e:
        print(f"Error checking storage bucket: {e}")
        return False


def delete_storage_bucket_if_exists(project_id: str, bucket_name: str, credentials=None) -> bool:
    """Delete storage bucket and all its contents if it exists."""
    try:
        client = storage.Client(project=project_id, credentials=credentials)
        
        try:
            bucket = client.get_bucket(bucket_name)
            print(f"📦 Found existing bucket: {bucket_name}")
            print(f"🗑️  Deleting bucket: {bucket_name} and all its contents...")
            
            # Use force=True to delete all objects in the bucket first, then the bucket itself.
            bucket.delete(force=True)
            
            print(f"✅ Successfully deleted bucket: {bucket_name}")
            return True
            
        except NotFound:
            print(f"✅ Bucket {bucket_name} does not exist - no cleanup needed")
            return True
            
    except Exception as e:
        print(f"❌ Failed to delete bucket: {bucket_name}")
        print(f"Error: {e}")
        return False


def create_storage_bucket(
    project_id: str,
    bucket_name: str,
    location: str = "US",
    storage_class: str = "STANDARD",
    credentials=None
) -> bool:
    """Create a new storage bucket"""
    try:
        client = storage.Client(project=project_id, credentials=credentials)
        
        bucket = client.bucket(bucket_name)
        bucket.storage_class = storage_class
        bucket = client.create_bucket(bucket, location=location)
        
        print(f"✅ Storage bucket '{bucket_name}' created successfully in {location}")
        return True
        
    except Exception as e:
        if "already exists" in str(e).lower():
            print(f"ℹ️  Storage bucket '{bucket_name}' already exists")
            return True
        print(f"❌ Failed to create storage bucket: {e}")
        return False


def manage_storage_bucket(
    project_id: str,
    bucket_name: str,
    location: str = "US",
    storage_class: str = "STANDARD",
    delete_if_exists: bool = True,
    credentials=None
) -> bool:
    """
    Manage storage bucket: check if exists, optionally delete and recreate
    """
    try:
        # Check if bucket exists
        exists = check_storage_bucket_exists(project_id, bucket_name, credentials)
        
        if exists:
            print(f"✅ Storage bucket '{bucket_name}' exists")
            
            if delete_if_exists:
                print(f"🧹 Deleting existing bucket '{bucket_name}'...")
                if not delete_storage_bucket_if_exists(project_id, bucket_name, credentials):
                    return False
                    
                # Create new bucket
                print(f"🔨 Creating new bucket '{bucket_name}'...")
                return create_storage_bucket(project_id, bucket_name, location, storage_class, credentials)
            else:
                print(f"ℹ️  Keeping existing bucket as requested.")
                return True
        else:
            print(f"ℹ️  Storage bucket '{bucket_name}' does not exist")
            # Create new bucket
            print(f"🔨 Creating storage bucket '{bucket_name}'...")
            return create_storage_bucket(project_id, bucket_name, location, storage_class, credentials)
            
    except Exception as e:
        print(f"❌ Error managing storage bucket: {e}")
        return False


def setup_promo_assets_bucket(project_id: str, credentials=None) -> bool:
    """Specific setup for promo-assets-for-b bucket used in ab-testing task"""
    
    success = delete_storage_bucket_if_exists(
        project_id=project_id,
        bucket_name="promo-assets-for-b",
        credentials=credentials
    )
    
    if success:
        print(f"🎯 Promo assets bucket cleanup completed for ab-testing task")
        return True
    else:
        print("❌ Failed to cleanup promo assets bucket")
        return False


def list_storage_buckets(project_id: str, credentials=None):
    """List all storage buckets in the project"""
    try:
        client = storage.Client(project=project_id, credentials=credentials)
        buckets = list(client.list_buckets())
        
        if not buckets:
            print("No storage buckets found in project")
        else:
            print(f"Storage buckets in project '{project_id}':")
            for bucket in buckets:
                print(f"  - {bucket.name} (location: {bucket.location}, storage_class: {bucket.storage_class})")
                
    except Exception as e:
        print(f"❌ Failed to list storage buckets: {e}")


def clean_bucket(project_id: str, credentials=None):
    """Main function to clean promo-assets-for-b bucket"""
    print("=" * 60)
    print("Cloud Storage Management for A/B Testing Task")
    print("=" * 60)
    
    # Clean promo-assets-for-b bucket
    print("\n1. Setting up clean promo-assets-for-b bucket...")
    success = setup_promo_assets_bucket(project_id, credentials)
    
    # List all storage buckets to verify
    print("\n2. Listing all storage buckets...")
    list_storage_buckets(project_id, credentials)
    
    print("\n✅ Storage bucket management complete!")
    return success


if __name__ == "__main__":
    import subprocess
    
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
    
    project_id = get_project_id()
    print(f"Using project: {project_id}")
    
    clean_bucket(project_id)