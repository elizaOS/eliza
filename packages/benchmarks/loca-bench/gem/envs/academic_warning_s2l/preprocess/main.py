from argparse import ArgumentParser
import os
import sys
import json
import csv
from pathlib import Path
from typing import Dict, List

from gem.utils.filesystem import nfs_safe_rmtree
from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase


def clean_dataset(db: GoogleCloudDatabase, project_id: str) -> bool:
    """Clean and setup BigQuery dataset for academic_warning"""
    print("=" * 60)
    print("BigQuery Dataset Management for Academic Warning Task")
    print("=" * 60)
    
    dataset_id = "academic_warning"
    
    try:
        # Check if dataset exists
        print(f"\n1. Checking if dataset '{dataset_id}' exists...")
        existing_dataset = db.get_bigquery_dataset(project_id, dataset_id)
        
        if existing_dataset:
            print(f"   ✅ Dataset '{dataset_id}' exists - deleting...")
            # Delete all tables in the dataset first
            tables = db.list_bigquery_tables(project_id, dataset_id)
            for table in tables:
                table_id = table['tableId']
                db.delete_bigquery_table(project_id, dataset_id, table_id)
                print(f"      ✓ Deleted table: {table_id}")
            
            # Delete the dataset
            db.delete_bigquery_dataset(project_id, dataset_id)
            print(f"   ✅ Dataset '{dataset_id}' deleted")
        else:
            print(f"   ℹ️  Dataset '{dataset_id}' does not exist")
        
        # Create new dataset
        print(f"\n2. Creating new dataset '{dataset_id}'...")
        dataset_info = {
            "location": "US",
            "description": "Academic warning system dataset for student performance analysis",
            "labels": {}
        }
        
        success = db.create_bigquery_dataset(project_id, dataset_id, dataset_info)
        
        if success:
            print(f"   ✅ Dataset '{dataset_id}' created successfully in US")
        else:
            print(f"   ❌ Failed to create dataset '{dataset_id}'")
            return False
        
        # List all datasets to verify
        print(f"\n3. Listing all datasets...")
        datasets = db.list_bigquery_datasets()
        if datasets:
            print(f"   Datasets in project '{project_id}':")
            for ds in datasets:
                print(f"      - {ds['datasetId']}")
        else:
            print("   No datasets found")
        
        print("\n✅ Dataset management complete!")
        print(f"   Ready to populate dataset '{dataset_id}' with exam CSV files.")
        return True
        
    except Exception as e:
        print(f"❌ Error in dataset cleanup: {e}")
        import traceback
        traceback.print_exc()
        return False


def clean_log(db: GoogleCloudDatabase) -> bool:
    """Clean and setup Cloud Logging for academic_warning
    Note: This is a simplified version since logging is not fully implemented in local DB
    """
    print("=" * 60)
    print("Cloud Logging Management for Academic Warning Task")
    print("=" * 60)
    
    print("\n✅ Log bucket management complete (simulated in local DB)")
    print("   Ready to write logs to 'exam_log'")
    return True


def generate_academic_data(task_root: Path,
                          num_students: int = 150,
                          num_exams: int = 7,
                          difficulty: str = "medium",
                          seed: int = 42,
                          **kwargs) -> bool:
    """Generate academic warning data using the data generator
    
    Args:
        task_root: Task root directory
        num_students: Number of students to generate
        num_exams: Number of historical exams
        difficulty: Difficulty level (easy/medium/hard)
        seed: Random seed
        **kwargs: Additional parameters for the generator
        
    Returns:
        True if generation succeeded
    """
    print("=" * 60)
    print("Generating Academic Warning Data")
    print("=" * 60)
    
    try:
        # Import the generator
        generator_script = task_root / "generate_academic_data.py"
        
        if not generator_script.exists():
            print(f"❌ Generator script not found: {generator_script}")
            return False
        
        # Build command
        import subprocess
        cmd = [
            sys.executable,
            str(generator_script),
            "--num-students", str(num_students),
            "--num-exams", str(num_exams),
            "--difficulty", difficulty,
            "--seed", str(seed),
            "--output-dir", str(task_root / "files"),
            "--save-groundtruth"
        ]
        
        print(f"🎲 Generation parameters:")
        print(f"   Students: {num_students}")
        print(f"   Historical exams: {num_exams}")
        print(f"   Difficulty: {difficulty}")
        print(f"   Seed: {seed}")
        
        # Run the generator
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(task_root)
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
                    "description": f"Academic warning table from {Path(csv_file).name}"
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
    
    # Data generation parameters
    parser.add_argument("--num-students", type=int, default=150,
                       help="Number of students to generate (default: 150)")
    parser.add_argument("--num-exams", type=int, default=50,
                       help="Number of historical exams (default: 3)")
    parser.add_argument("--difficulty", type=str, default="medium",
                       choices=["easy", "medium", "hard"],
                       help="Difficulty level (default: medium)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    
    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("🚀 Academic Warning Task Environment Preprocessing")
    print("=" * 60)
    print("Using local Google Cloud database")
    
    # Determine Google Cloud database directory
    # First check environment variable (set by environment)
    gcloud_db_dir = os.environ.get('GOOGLE_CLOUD_DATA_DIR')
    
    if not gcloud_db_dir:
        # Fallback: derive from agent_workspace if provided
        if args.agent_workspace:
            workspace_parent = Path(args.agent_workspace).parent
            gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
        else:
            gcloud_db_dir = str(MCP_CONVERT_PATH / "mcps" / "google_cloud" / "data")
    
    print(f"\n📂 Google Cloud Database Directory: {gcloud_db_dir}")
    
    # Clean up existing database directory before starting
    import shutil
    if Path(gcloud_db_dir).exists():
        print(f"🗑️  Cleaning existing database directory...")
        try:
            nfs_safe_rmtree(gcloud_db_dir)
            print(f"   ✓ Removed old database files")
        except Exception as e:
            print(f"   ⚠️  Warning: Could not fully clean directory: {e}")
    
    # Create fresh database directory
    Path(gcloud_db_dir).mkdir(parents=True, exist_ok=True)
    print(f"   ✓ Created fresh database directory")
    
    # Initialize GoogleCloudDatabase
    print("\n📊 Initializing Google Cloud Database...")
    gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)
    
    # Use a default project ID for local database
    project_id = "local-project"
    print(f"   Using project: {project_id}")
    
    # Get task root directory
    # When run via subprocess, cwd is set to temp_task_root by the environment
    task_root = Path.cwd()

    # Step 0: Generate academic warning data
    print("\n" + "=" * 60)
    print("STEP 0: Generate Academic Warning Data")
    print("=" * 60)
    
    # Clean up existing data files before generation
    print("\n🗑️  Cleaning up existing data files...")
    files_to_clean = [
        task_root / "files",
        task_root / "initial_workspace", 
        task_root / "groundtruth_workspace"
    ]
    
    for folder in files_to_clean:
        if folder.exists():
            # Remove all CSV files in the directory
            csv_files = list(folder.glob("*.csv"))
            for csv_file in csv_files:
                try:
                    csv_file.unlink()
                    print(f"   ✓ Removed {csv_file.name}")
                except Exception as e:
                    print(f"   ⚠️  Warning: Could not remove {csv_file.name}: {e}")
        else:
            # Create directory if it doesn't exist
            folder.mkdir(parents=True, exist_ok=True)
            print(f"   ✓ Created directory {folder.name}")
    
    print("   ✓ Cleanup complete")
    
    if not generate_academic_data(
        task_root=task_root,
        num_students=args.num_students,
        num_exams=args.num_exams,
        difficulty=args.difficulty,
        seed=args.seed
    ):
        print("❌ Data generation failed!")
        sys.exit(1)

    # Step 1: Clean logs
    print("\n" + "=" * 60)
    print("STEP 1: Clean Log Buckets")
    print("=" * 60)
    clean_log(gcloud_db)

    # Step 2: Clean dataset
    print("\n" + "=" * 60)
    print("STEP 2: Clean BigQuery Dataset")
    print("=" * 60)
    if not clean_dataset(gcloud_db, project_id):
        print("❌ Dataset cleanup failed!")
        sys.exit(1)

    # Wait message (not actually waiting since we're using local DB)
    print("\n" + "=" * 60)
    print("⏳ Configuration complete (no wait needed for local DB)")
    print("=" * 60)

    # Step 3: Upload CSV files
    print("\n" + "=" * 60)
    print("STEP 3: Upload CSV Files to BigQuery")
    print("=" * 60)
    
    # Get CSV folder path
    csv_folder = task_root / "files"
    
    if not csv_folder.exists():
        print(f"❌ CSV folder not found: {csv_folder}")
        sys.exit(1)
    
    if not upload_csvs_to_bigquery(
        db=gcloud_db,
        project_id=project_id,
        dataset_id="academic_warning",
        csv_folder=str(csv_folder),
        csv_pattern="*.csv"
    ):
        print("❌ CSV upload failed!")
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
        print(f"\n📄 Environment variable file created: {env_file}")
    except Exception as e:
        print(f"⚠️  Unable to create environment variable file: {e}")
    
    # Copy latest_quiz_scores.csv to agent workspace
    if args.agent_workspace:
        print("\n" + "=" * 60)
        print("STEP 4: Copy Initial Files to Agent Workspace")
        print("=" * 60)
        
        agent_workspace_path = Path(args.agent_workspace)
        agent_workspace_path.mkdir(parents=True, exist_ok=True)
        
        # Copy latest_quiz_scores.csv
        source_file = task_root / "initial_workspace" / "latest_quiz_scores.csv"
        dest_file = agent_workspace_path / "latest_quiz_scores.csv"
        
        try:
            shutil.copy2(source_file, dest_file)
            print(f"✅ Copied latest_quiz_scores.csv to agent workspace")
            print(f"   Source: {source_file}")
            print(f"   Destination: {dest_file}")
        except Exception as e:
            print(f"⚠️  Warning: Could not copy latest_quiz_scores.csv: {e}")
    
    print("\n" + "=" * 60)
    print("🎉 Academic Warning Task Environment Preprocessing Complete!")
    print("=" * 60)
    print(f"✅ Google Cloud database initialized")
    print(f"✅ BigQuery dataset 'academic_warning' created and populated")
    print(f"✅ Cloud Logging configured")
    
    # Count tables
    tables = gcloud_db.list_bigquery_tables(project_id, "academic_warning")
    print(f"\n📊 Dataset Statistics:")
    print(f"   Tables created: {len(tables)}")
    for table in tables:
        print(f"      - {table['tableId']}: {table.get('numRows', 0)} rows")
    
    print(f"\n📂 Directory Locations:")
    print(f"   Google Cloud DB: {gcloud_db_dir}")
    if args.agent_workspace:
        print(f"   Agent Workspace: {args.agent_workspace}")
    
    print(f"\n📌 Environment Variables:")
    print(f"   GOOGLE_CLOUD_DATA_DIR={gcloud_db_dir}")
    
    print(f"\n💡 Next Step: Agent can now use google-cloud-simplified MCP server")
    print(f"   to query and analyze the academic warning data")
