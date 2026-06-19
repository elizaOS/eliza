from argparse import ArgumentParser
import os
import sys
import json
import csv
from pathlib import Path
from typing import Dict, List
from gem.utils.filesystem import nfs_safe_rmtree
from gem.utils.logging import VerboseLogger

# Add current directory to path to import local modules
current_dir = Path(__file__).parent
sys.path.insert(0, str(current_dir))

# Add mcp_convert path to import GoogleCloudDatabase
from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase

# # Import GoogleCloudDatabase from gem project
# from gem.tools.mcp_server.google_cloud.database import GoogleCloudDatabase


def clean_dataset(db: GoogleCloudDatabase, project_id: str, log: VerboseLogger = None) -> bool:
    """Clean and setup BigQuery dataset for ab_testing"""
    if log is None:
        log = VerboseLogger(verbose=True)  # Default to verbose for backwards compatibility

    dataset_id = "ab_testing"

    try:
        # Check if dataset exists
        log.info(f"\n1. Checking if dataset '{dataset_id}' exists...")
        existing_dataset = db.get_bigquery_dataset(project_id, dataset_id)

        if existing_dataset:
            log.info(f"   Dataset '{dataset_id}' exists - deleting...")
            # Delete all tables in the dataset first
            tables = db.list_bigquery_tables(project_id, dataset_id)
            for table in tables:
                table_id = table['tableId']
                db.delete_bigquery_table(project_id, dataset_id, table_id)
                log.info(f"      Deleted table: {table_id}")

            # Delete the dataset
            db.delete_bigquery_dataset(project_id, dataset_id)
            log.info(f"   Dataset '{dataset_id}' deleted")
        else:
            log.info(f"   Dataset '{dataset_id}' does not exist")

        # Create new dataset
        log.info(f"\n2. Creating new dataset '{dataset_id}'...")
        dataset_info = {
            "location": "US",
            "description": "A/B testing dataset for conversion rate analysis",
            "labels": {}
        }

        success = db.create_bigquery_dataset(project_id, dataset_id, dataset_info)

        if success:
            log.success(f"   Dataset '{dataset_id}' created successfully in US")
        else:
            log.error(f"Failed to create dataset '{dataset_id}'")
            return False

        # List all datasets to verify
        log.info(f"\n3. Listing all datasets...")
        datasets = db.list_bigquery_datasets()
        if datasets:
            log.info(f"   Datasets in project '{project_id}':")
            for ds in datasets:
                log.info(f"      - {ds['datasetId']}")
        else:
            log.info("   No datasets found")

        log.success("\nDataset management complete!")
        log.info(f"   Ready to populate dataset '{dataset_id}' with A/B testing CSV files.")
        return True

    except Exception as e:
        log.error(f"Error in dataset cleanup: {e}")
        import traceback
        traceback.print_exc()
        return False


def clean_bucket(db: GoogleCloudDatabase) -> bool:
    """Clean Cloud Storage bucket for ab_testing"""
    print("=" * 60)
    print("Cloud Storage Management for A/B Testing Task")
    print("=" * 60)
    
    bucket_name = "promo-assets-for-b"
    
    try:
        # Check if bucket exists
        print(f"\n1. Checking if bucket '{bucket_name}' exists...")
        existing_bucket = db.get_storage_bucket(bucket_name)
        
        if existing_bucket:
            print(f"   📦 Found existing bucket: {bucket_name}")
            print(f"   🗑️  Deleting bucket: {bucket_name} and all its contents...")
            
            # Delete all objects in the bucket first
            objects = db.list_storage_objects(bucket_name)
            for obj in objects:
                db.delete_storage_object(bucket_name, obj['name'])
                print(f"      ✓ Deleted object: {obj['name']}")
            
            # Delete the bucket
            db.delete_storage_bucket(bucket_name)
            print(f"   ✅ Successfully deleted bucket: {bucket_name}")
        else:
            print(f"   ✅ Bucket {bucket_name} does not exist - no cleanup needed")
        
        # List all storage buckets to verify
        print(f"\n2. Listing all storage buckets...")
        buckets = db.list_storage_buckets()
        if buckets:
            print(f"   Storage buckets:")
            for bucket in buckets:
                print(f"      - {bucket['name']} (location: {bucket.get('location', 'Unknown')})")
        else:
            print("   No storage buckets found")
        
        print("\n✅ Storage bucket management complete!")
        return True
        
    except Exception as e:
        print(f"❌ Error in bucket cleanup: {e}")
        import traceback
        traceback.print_exc()
        return False


def clean_log(db: GoogleCloudDatabase) -> bool:
    """Clean and setup Cloud Logging for ab_testing
    Note: This is a simplified version since logging is not fully implemented in local DB
    """
    print("=" * 60)
    print("Cloud Logging Management for A/B Testing Task")
    print("=" * 60)
    
    print("\n✅ Log bucket management complete (simulated in local DB)")
    print("   Ready to write logs to 'abtesting_logging'")
    return True


def generate_ab_test_data(task_root: Path,
                         num_scenarios: int = 20,
                         num_days: int = 15,
                         difficulty: str = "medium",
                         seed: int = 42,
                         **kwargs) -> bool:
    """Generate A/B test data using the data generator
    
    Args:
        task_root: Task root directory (task_dir, where data will be generated)
        num_scenarios: Number of scenarios to generate
        num_days: Number of days per scenario
        difficulty: Difficulty level (easy/medium/hard)
        seed: Random seed
        **kwargs: Additional parameters for the generator
        
    Returns:
        True if generation succeeded
    """
    print("=" * 60)
    print("Generating A/B Test Data")
    print("=" * 60)
    
    try:
        # Get generator script from code directory (not task_dir)
        code_dir = Path(__file__).parent.parent
        generator_script = code_dir / "generate_ab_data.py"
        
        if not generator_script.exists():
            print(f"❌ Generator script not found: {generator_script}")
            return False
        
        # Build command - output to task_root (task_dir)
        import subprocess
        cmd = [
            sys.executable,
            str(generator_script),
            "--num-scenarios", str(num_scenarios),
            "--num-days", str(num_days),
            "--difficulty", difficulty,
            "--seed", str(seed),
            "--output-dir", str(task_root / "files"),
            "--groundtruth-dir", str(task_root / "groundtruth_workspace"),
            "--save-groundtruth"
        ]
        
        # Add additional parameters
        for key, value in kwargs.items():
            if value is not None:
                param_name = "--" + key.replace("_", "-")
                cmd.extend([param_name, str(value)])
        
        print(f"🎲 Generation parameters:")
        print(f"   Scenarios: {num_scenarios}")
        print(f"   Days per scenario: {num_days}")
        print(f"   Rows per scenario: {num_days * 24}")
        print(f"   Difficulty: {difficulty}")
        print(f"   Seed: {seed}")
        
        # Run the generator (cwd doesn't matter since we use absolute paths)
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True
        )
        
        # Output generator's output
        if result.stdout:
            print(result.stdout)
        
        if result.returncode != 0:
            print(f"❌ Data generation failed:")
            if result.stderr:
                print(result.stderr)
            return False
        
        print("✅ Data generation successful!")
        return True
        
    except Exception as e:
        print(f"❌ Data generation error: {e}")
        import traceback
        traceback.print_exc()
        return False


def upload_csvs_to_bigquery(db: GoogleCloudDatabase, 
                            project_id: str,
                            dataset_id: str,
                            csv_folder: str,
                            csv_pattern: str = "*.csv") -> bool:
    """Upload CSV files to BigQuery tables in local database"""
    print("=" * 60)
    print("Uploading CSV Files to BigQuery")
    print("=" * 60)
    
    try:
        # Find all CSV files
        import glob
        csv_files = glob.glob(os.path.join(csv_folder, csv_pattern))
        
        if not csv_files:
            print(f"❌ No CSV files found matching pattern {csv_pattern} in {csv_folder}")
            return False
        
        print(f"\n📁 Found {len(csv_files)} CSV files to upload")
        
        # Upload each CSV file
        for csv_file in csv_files:
            # Extract table name from filename (without extension)
            table_name = Path(csv_file).stem
            
            # Clean table name (BigQuery table names have restrictions)
            table_name = table_name.replace("-", "_").replace(" ", "_")
            
            print(f"\n📤 Uploading {Path(csv_file).name} -> {dataset_id}.{table_name}")
            
            try:
                # Read CSV file
                rows = []
                with open(csv_file, 'r', encoding='utf-8') as f:
                    reader = csv.DictReader(f)
                    fieldnames = reader.fieldnames
                    
                    for row in reader:
                        # Convert numeric fields
                        converted_row = {}
                        for key, value in row.items():
                            # Try to convert to number
                            try:
                                if '.' in value:
                                    converted_row[key] = float(value)
                                else:
                                    converted_row[key] = int(value)
                            except (ValueError, AttributeError):
                                converted_row[key] = value
                        rows.append(converted_row)
                
                if not rows:
                    print(f"   ⚠️  No data in {csv_file}")
                    continue
                
                # Create schema from first row
                schema = []
                for key, value in rows[0].items():
                    if isinstance(value, int):
                        field_type = "INTEGER"
                    elif isinstance(value, float):
                        field_type = "FLOAT"
                    else:
                        field_type = "STRING"
                    
                    schema.append({
                        "name": key,
                        "type": field_type,
                        "mode": "NULLABLE"
                    })
                
                # Create table
                table_info = {
                    "schema": schema,
                    "description": f"A/B testing table from {Path(csv_file).name}"
                }
                
                # Check if table exists, delete if so
                existing_table = db.get_bigquery_table(project_id, dataset_id, table_name)
                if existing_table:
                    db.delete_bigquery_table(project_id, dataset_id, table_name)
                    print(f"   ✓ Deleted existing table")
                
                # Create new table
                db.create_bigquery_table(project_id, dataset_id, table_name, table_info)
                print(f"   ✓ Created table with {len(schema)} columns")
                
                # Insert rows
                success = db.insert_table_rows(project_id, dataset_id, table_name, rows)
                
                if success:
                    print(f"   ✅ Loaded {len(rows)} rows into {dataset_id}.{table_name}")
                else:
                    print(f"   ❌ Failed to insert rows into {table_name}")
                    
            except Exception as e:
                print(f"   ❌ Error uploading {csv_file}: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        print("\n✅ CSV upload complete!")
        return True
        
    except Exception as e:
        print(f"❌ Error in CSV upload: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--launch_time", required=False, help="Launch time")
    parser.add_argument("--verbose", "-v", action="store_true",
                       help="Enable verbose output (default: errors only)")

    # Data generation parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip data generation, use existing CSV files")
    parser.add_argument("--num-scenarios", type=int, default=50,
                       help="Number of scenarios to generate (default: 20)")
    parser.add_argument("--num-days", type=int, default=15,
                       help="Number of days per scenario (default: 15)")
    parser.add_argument("--difficulty", type=str, default="medium",
                       choices=["easy", "medium", "hard"],
                       help="Difficulty level (default: medium)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    
    # Advanced generation parameters
    parser.add_argument("--base-conversion-min", type=float, default=None,
                       help="Minimum base conversion rate")
    parser.add_argument("--base-conversion-max", type=float, default=None,
                       help="Maximum base conversion rate")
    parser.add_argument("--conversion-diff-min", type=float, default=None,
                       help="Minimum conversion rate difference")
    parser.add_argument("--conversion-diff-max", type=float, default=None,
                       help="Maximum conversion rate difference")
    parser.add_argument("--click-min", type=int, default=None,
                       help="Minimum click count")
    parser.add_argument("--click-max", type=int, default=None,
                       help="Maximum click count")
    parser.add_argument("--noise-level", type=float, default=None,
                       help="Noise level for conversion rates")
    parser.add_argument("--zero-probability", type=float, default=None,
                       help="Probability of zero values")
    
    args = parser.parse_args()

    # Set up verbose-aware logging
    log = VerboseLogger(verbose=args.verbose)

    log.section("A/B Testing Task Environment Preprocessing")
    log.info("Using local Google Cloud database")

    # Determine Google Cloud database directory
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
    else:
        gcloud_db_dir = str(Path(__file__).parent.parent / "local_db" / "google_cloud")

    log.info(f"\nGoogle Cloud Database Directory: {gcloud_db_dir}")

    # Clean up existing database directory before starting
    import shutil
    if Path(gcloud_db_dir).exists():
        log.info("Cleaning existing database directory...")
        try:
            nfs_safe_rmtree(gcloud_db_dir)
            log.info("   Removed old database files")
        except Exception as e:
            log.error(f"Warning: Could not fully clean directory: {e}")

    # Create fresh database directory
    Path(gcloud_db_dir).mkdir(parents=True, exist_ok=True)
    log.info("   Created fresh database directory")

    # Initialize GoogleCloudDatabase
    log.info("\nInitializing Google Cloud Database...")
    gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)

    # Use a default project ID for local database
    project_id = "local-project"
    log.info(f"   Using project: {project_id}")

    # Get task root directory from agent_workspace (should be task_dir)
    if args.agent_workspace:
        task_root = Path(args.agent_workspace).parent
    else:
        # Fallback to code directory (not recommended for parallel runs)
        task_root = Path(__file__).parent.parent

    log.info(f"   Task root directory: {task_root}")

    # Step 0: Generate A/B test data (optional)
    if not args.skip_generation:
        log.step(0, "Generate A/B Test Data")

        # Prepare advanced parameters
        advanced_params = {}
        if args.base_conversion_min is not None:
            advanced_params['base_conversion_min'] = args.base_conversion_min
        if args.base_conversion_max is not None:
            advanced_params['base_conversion_max'] = args.base_conversion_max
        if args.conversion_diff_min is not None:
            advanced_params['conversion_diff_min'] = args.conversion_diff_min
        if args.conversion_diff_max is not None:
            advanced_params['conversion_diff_max'] = args.conversion_diff_max
        if args.click_min is not None:
            advanced_params['click_min'] = args.click_min
        if args.click_max is not None:
            advanced_params['click_max'] = args.click_max
        if args.noise_level is not None:
            advanced_params['noise_level'] = args.noise_level
        if args.zero_probability is not None:
            advanced_params['zero_probability'] = args.zero_probability

        if not generate_ab_test_data(
            task_root=task_root,
            num_scenarios=args.num_scenarios,
            num_days=args.num_days,
            difficulty=args.difficulty,
            seed=args.seed,
            **advanced_params
        ):
            log.error("Data generation failed!")
            sys.exit(1)
    else:
        log.step(0, "Skip Data Generation")
        log.info("Using existing CSV files in files/ directory")

    # Step 1: Clean logs
    log.step(1, "Clean Log Buckets")
    clean_log(gcloud_db)

    # Step 2: Clean dataset
    log.step(2, "Clean BigQuery Dataset")
    if not clean_dataset(gcloud_db, project_id, log):
        log.error("Dataset cleanup failed!")
        sys.exit(1)

    # Step 3: Clean bucket
    log.step(3, "Clean Cloud Storage Bucket")
    if not clean_bucket(gcloud_db):
        log.error("Bucket cleanup failed!")
        sys.exit(1)

    # Wait message (not actually waiting since we're using local DB)
    log.info("\nConfiguration complete (no wait needed for local DB)")

    # Step 4: Upload CSV files
    log.step(4, "Upload CSV Files to BigQuery")

    # Get CSV folder path
    csv_folder = task_root / "files"

    if not csv_folder.exists():
        log.error(f"CSV folder not found: {csv_folder}")
        sys.exit(1)

    if not upload_csvs_to_bigquery(
        db=gcloud_db,
        project_id=project_id,
        dataset_id="ab_testing",
        csv_folder=str(csv_folder),
        csv_pattern="*.csv"
    ):
        log.error("CSV upload failed!")
        sys.exit(1)

    # Set environment variable for evaluation
    os.environ['GOOGLE_CLOUD_DATA_DIR'] = gcloud_db_dir

    # Write environment variable file
    env_file = Path(gcloud_db_dir).parent / ".gcloud_env"
    try:
        from datetime import datetime
        with open(env_file, 'w') as f:
            f.write(f"# Google Cloud Database Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export GOOGLE_CLOUD_DATA_DIR={gcloud_db_dir}\n")
        log.info(f"\nEnvironment variable file created: {env_file}")
    except Exception as e:
        log.error(f"Unable to create environment variable file: {e}")

    log.section("A/B Testing Task Environment Preprocessing Complete!")
    log.success("Google Cloud database initialized")
    log.success("BigQuery dataset 'ab_testing' created and populated")
    log.success("Cloud Storage bucket cleaned")
    log.success("Cloud Logging configured")

    # Count tables
    tables = gcloud_db.list_bigquery_tables(project_id, "ab_testing")
    log.info(f"\nDataset Statistics:")
    log.info(f"   Tables created: {len(tables)}")
    for table in tables:
        log.info(f"      - {table['tableId']}: {table.get('numRows', 0)} rows")

    log.info(f"\nDirectory Locations:")
    log.info(f"   Google Cloud DB: {gcloud_db_dir}")
    if args.agent_workspace:
        log.info(f"   Agent Workspace: {args.agent_workspace}")

    log.info(f"\nEnvironment Variables:")
    log.info(f"   GOOGLE_CLOUD_DATA_DIR={gcloud_db_dir}")

    log.info(f"\nNext Step: Agent can now use google-cloud-simplified MCP server")
    log.info(f"   to query and analyze the A/B testing data")
