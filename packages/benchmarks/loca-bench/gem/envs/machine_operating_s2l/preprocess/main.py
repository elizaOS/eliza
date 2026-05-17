from argparse import ArgumentParser
import os
import sys
import json
import csv
from pathlib import Path
from typing import Dict, List
import random
random.seed(42)



from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase
from gem.utils.filesystem import nfs_safe_rmtree

def clean_bucket(db: GoogleCloudDatabase, bucket_name: str = "iot_anomaly_reports") -> bool:
    """Clean Cloud Storage bucket for machine operating task"""
    print("=" * 60)
    print(f"Cloud Storage Management for Machine Operating Task")
    print("=" * 60)
    
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

def clean_dataset(db: GoogleCloudDatabase, project_id: str, dataset_name: str = "machine_operating") -> bool:
    """Clean and setup BigQuery dataset for machine operating task"""
    print("=" * 60)
    print("BigQuery Dataset Management for Machine Operating Task")
    print("=" * 60)
    
    try:
        # Check if dataset exists
        print(f"\n1. Checking if dataset '{dataset_name}' exists...")
        existing_dataset = db.get_bigquery_dataset(project_id, dataset_name)
        
        if existing_dataset:
            print(f"   ✅ Dataset '{dataset_name}' exists - deleting...")
            # Delete all tables in the dataset first
            tables = db.list_bigquery_tables(project_id, dataset_name)
            for table in tables:
                table_id = table['tableId']
                db.delete_bigquery_table(project_id, dataset_name, table_id)
                print(f"      ✓ Deleted table: {table_id}")
            
            # Delete the dataset
            db.delete_bigquery_dataset(project_id, dataset_name)
            print(f"   ✅ Dataset '{dataset_name}' deleted")
        else:
            print(f"   ℹ️  Dataset '{dataset_name}' does not exist")
        
        # Create new dataset
        print(f"\n2. Creating new dataset '{dataset_name}'...")
        dataset_info = {
            "location": "US",
            "description": "Machine operating dataset for IoT sensor data analysis",
            "labels": {}
        }
        
        success = db.create_bigquery_dataset(project_id, dataset_name, dataset_info)
        
        if success:
            print(f"   ✅ Dataset '{dataset_name}' created successfully in US")
        else:
            print(f"   ❌ Failed to create dataset '{dataset_name}'")
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
        print(f"   Ready to populate dataset '{dataset_name}' with sensor CSV file.")
        return True
        
    except Exception as e:
        print(f"❌ Error in dataset cleanup: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_machine_operating_data(task_root: Path,
                                   hours: int = 2,
                                   interval_minutes: int = 5,
                                   anomaly_rate: float = 0.15,
                                   difficulty: str = "medium",
                                   seed: int = 42,
                                   **kwargs) -> bool:
    """Generate machine operating sensor data
    
    Args:
        task_root: Task root directory
        hours: Time duration in hours
        interval_minutes: Sampling interval in minutes
        anomaly_rate: Anomaly probability
        difficulty: Difficulty level (easy/medium/hard)
        seed: Random seed
        **kwargs: Additional parameters for the generator
        
    Returns:
        True if generation succeeded
    """
    print("=" * 60)
    print("Generating Machine Operating Sensor Data")
    print("=" * 60)
    
    try:
        # Import the generator
        import sys
        import subprocess
        
        generator_script = Path(__file__).parent / "construct_data.py"
        
        if not generator_script.exists():
            print(f"❌ Generator script not found: {generator_script}")
            return False
        
        # Map difficulty to preset
        difficulty_presets = {
            "easy": "small",
            "medium": "medium", 
            "hard": "large"
        }
        
        # Create temporary output directory for generation
        temp_output_dir = task_root / "files" / "temp"
        temp_output_dir.mkdir(parents=True, exist_ok=True)
        
        # Build command
        cmd = [
            sys.executable,
            str(generator_script),
            "--hours", str(hours),
            "--interval", str(interval_minutes),
            "--anomaly-rate", str(anomaly_rate),
            "--seed", str(seed),
            "--output-dir", str(temp_output_dir)
        ]
        
        # Add preset if using standard difficulty
        if difficulty in difficulty_presets:
            # Don't use preset for custom parameters, apply them individually
            pass
        
        # Add additional parameters
        for key, value in kwargs.items():
            if value is not None:
                param_name = "--" + key.replace("_", "-")
                if isinstance(value, bool):
                    if value:
                        cmd.append(param_name)
                else:
                    cmd.extend([param_name, str(value)])
        
        print(f"🎲 Generation parameters:")
        print(f"   Hours: {hours}")
        print(f"   Interval: {interval_minutes} minutes")
        print(f"   Anomaly rate: {anomaly_rate}")
        print(f"   Difficulty: {difficulty}")
        print(f"   Seed: {seed}")
        
        # Run the generator in the preprocess directory
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent)
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
        
        # Note: Don't move files yet, groundtruth calculation needs them in preprocess dir
        # Files will be moved after groundtruth is generated
        
        return True
        
    except Exception as e:
        print(f"❌ Data generation error: {e}")
        import traceback
        traceback.print_exc()
        return False


def organize_generated_files(task_root: Path) -> bool:
    """Organize generated files to their target locations
    
    Args:
        task_root: Task root directory
        
    Returns:
        True if successful
    """
    print("=" * 60)
    print("Organizing Generated Files")
    print("=" * 60)
    
    try:
        import shutil
        
        # Source directory is the temp directory where files were generated
        temp_dir = task_root / "files" / "temp"
        
        # 1. Move live_sensor_data.csv to task_root/files/machine_operating/live_sensor.csv
        source_csv = temp_dir / "live_sensor_data.csv"
        machine_operating_dir = task_root / "files" / "machine_operating"
        machine_operating_dir.mkdir(parents=True, exist_ok=True)
        dest_csv = machine_operating_dir / "live_sensor.csv"
        
        if source_csv.exists():
            shutil.copy2(str(source_csv), str(dest_csv))  # Copy instead of move for groundtruth
            print(f"✅ Copied live_sensor_data.csv to {dest_csv}")
        else:
            print(f"⚠️  Warning: live_sensor_data.csv not found in {temp_dir}")
        
        # 2. Move machine_operating_parameters.xlsx to task_root/initial_workspace/
        source_xlsx = temp_dir / "machine_operating_parameters.xlsx"
        initial_workspace_dir = task_root / "initial_workspace"
        initial_workspace_dir.mkdir(parents=True, exist_ok=True)
        dest_xlsx = initial_workspace_dir / "machine_operating_parameters.xlsx"
        
        if source_xlsx.exists():
            shutil.copy2(str(source_xlsx), str(dest_xlsx))  # Copy for groundtruth to use
            print(f"✅ Copied machine_operating_parameters.xlsx to {dest_xlsx}")
        else:
            print(f"⚠️  Warning: machine_operating_parameters.xlsx not found in {temp_dir}")
        
        # 3. Clean up temp directory
        if temp_dir.exists():
            nfs_safe_rmtree(temp_dir)
            print(f"✅ Cleaned up temporary directory: {temp_dir}")
        
        return True
        
    except Exception as e:
        print(f"❌ File organization error: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_groundtruth(task_root: Path) -> bool:
    """Generate groundtruth anomaly report
    
    Args:
        task_root: Task root directory
        
    Returns:
        True if generation succeeded
    """
    print("=" * 60)
    print("Generating Groundtruth Anomaly Report")
    print("=" * 60)
    
    try:
        import subprocess
        
        calculator_script = Path(__file__).parent / "calculate_groundtruth.py"
        
        if not calculator_script.exists():
            print(f"❌ Calculator script not found: {calculator_script}")
            return False
        
        # Define file paths from task_root
        sensor_data_path = task_root / "files" / "machine_operating" / "live_sensor.csv"
        parameters_path = task_root / "initial_workspace" / "machine_operating_parameters.xlsx"
        output_path = task_root / "groundtruth_workspace" / "anomaly_report.csv"
        
        # Ensure groundtruth_workspace directory exists
        (task_root / "groundtruth_workspace").mkdir(parents=True, exist_ok=True)
        
        # Build command with explicit paths
        cmd = [
            sys.executable, 
            str(calculator_script),
            "--sensor-data", str(sensor_data_path),
            "--parameters", str(parameters_path),
            "--output", str(output_path),
            "--task-root", str(task_root)
        ]
        
        print(f"📊 Calculating groundtruth from generated sensor data...")
        
        # Run the calculator
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent)
        )
        
        # Output calculator's output
        if result.stdout:
            print(result.stdout)
        
        if result.returncode != 0:
            print(f"❌ Groundtruth generation failed:")
            if result.stderr:
                print(result.stderr)
            return False
        
        print("✅ Groundtruth generation successful!")
        
        # Verify the output file was created
        if output_path.exists():
            print(f"✅ Groundtruth report saved to {output_path}")
        else:
            print(f"⚠️  Warning: Groundtruth report not found at {output_path}")
            return False
        
        return True
        
    except Exception as e:
        print(f"❌ Groundtruth generation error: {e}")
        import traceback
        traceback.print_exc()
        return False


def upload_csv_to_bigquery(db: GoogleCloudDatabase,
                           project_id: str,
                           dataset_id: str,
                           csv_file_path: str,
                           table_name: str = "live_sensor") -> bool:
    """Upload CSV file to BigQuery table in local database"""
    print("=" * 60)
    print(f"Uploading CSV File to BigQuery")
    print("=" * 60)
    
    try:
        if not os.path.exists(csv_file_path):
            print(f"❌ CSV file not found: {csv_file_path}")
            return False
        
        print(f"\n📤 Uploading {Path(csv_file_path).name} -> {dataset_id}.{table_name}")
        
        # Read CSV file
        rows = []
        with open(csv_file_path, 'r', encoding='utf-8') as f:
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
            print(f"   ⚠️  No data in {csv_file_path}")
            return False
        
        print(f"   ✓ Read {len(rows)} rows from CSV")
        
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
            "description": f"Machine operating sensor data from {Path(csv_file_path).name}"
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
            return True
        else:
            print(f"   ❌ Failed to insert rows into {table_name}")
            return False
            
    except Exception as e:
        print(f"❌ Error uploading CSV: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__=="__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False,
                       help="Agent workspace directory")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    parser.add_argument("--csv-file", type=str, default=None,
                       help="Path to CSV file (default: ./machine_operating/live_sensor.csv)")
    
    # Data generation parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip data generation, use existing CSV files")
    parser.add_argument("--hours", type=float, default=72,
                       help="Time duration in hours (default: 2)")
    parser.add_argument("--interval", type=float, default=5,
                       help="Sampling interval in minutes (default: 5)")
    parser.add_argument("--anomaly-rate", type=float, default=0.15,
                       help="Anomaly probability (default: 0.15)")
    parser.add_argument("--difficulty", type=str, default="medium",
                       choices=["easy", "medium", "hard"],
                       help="Difficulty level (default: medium)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    
    # Advanced generation parameters
    parser.add_argument("--total-machines", type=int, default=25,
                       help="Total number of machines to generate (can be less than or more than 10, default: 10)")
    parser.add_argument("--total-sensors", type=str, default="6",
                       help="Total sensor types: either a number (e.g., '3' for first 3 base sensors) or comma-separated names (default: 6 base sensors)")
    parser.add_argument("--complexity", type=float, default=None,
                       help="Complexity multiplier")
    parser.add_argument("--multi-anomaly", action="store_true",
                       help="Enable multi-anomaly mode")
    parser.add_argument("--cascade-failure", action="store_true",
                       help="Enable cascade failure mode")
    parser.add_argument("--noise", action="store_true",
                       help="Enable noise injection")
    
    args = parser.parse_args()
    
    print("\n" + "=" * 60)
    print("🚀 Machine Operating Task Environment Preprocessing")
    print("=" * 60)
    print("Using local Google Cloud database")
    
    # Determine Google Cloud database directory
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
    else:
        gcloud_db_dir = str(Path(__file__).parent.parent / "local_db" / "google_cloud")
    
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
    
    # Get task root directory from agent_workspace
    # task_root should be the parent of agent_workspace (i.e., task_dir)
    if args.agent_workspace:
        task_root = Path(args.agent_workspace).parent
    else:
        # Fallback to code directory (for standalone testing)
        task_root = Path(__file__).parent.parent
    
    print(f"\n📂 Task Root Directory: {task_root}")
    
    # Step 0: Generate machine operating data (optional)
    if not args.skip_generation:
        print("\n" + "=" * 60)
        print("STEP 0: Generate Machine Operating Sensor Data")
        print("=" * 60)
        
        # Clean up existing data files before generation
        print("\n🗑️  Cleaning up existing data files...")
        files_to_clean = [
            task_root / "files" / "machine_operating",
            task_root / "initial_workspace",
            task_root / "groundtruth_workspace"
        ]
        
        for folder in files_to_clean:
            if folder.exists():
                # Remove relevant files
                csv_files = list(folder.glob("*.csv"))
                xlsx_files = list(folder.glob("*.xlsx"))
                
                for file in csv_files + xlsx_files:
                    try:
                        file.unlink()
                        print(f"   ✓ Removed {file.name}")
                    except Exception as e:
                        print(f"   ⚠️  Warning: Could not remove {file.name}: {e}")
            else:
                folder.mkdir(parents=True, exist_ok=True)
                print(f"   ✓ Created directory {folder.name}")
        
        print("   ✓ Cleanup complete")
        
        # Prepare advanced parameters
        advanced_params = {}
        if args.total_machines is not None:
            advanced_params['total_machines'] = args.total_machines
        if args.total_sensors is not None:
            advanced_params['total_sensors'] = args.total_sensors
        if args.complexity is not None:
            advanced_params['complexity'] = args.complexity
        if args.multi_anomaly:
            advanced_params['multi_anomaly'] = True
        if args.cascade_failure:
            advanced_params['cascade_failure'] = True
        if args.noise:
            advanced_params['noise'] = True
        
        # Generate sensor data
        if not generate_machine_operating_data(
            task_root=task_root,
            hours=args.hours,
            interval_minutes=args.interval,
            anomaly_rate=args.anomaly_rate,
            difficulty=args.difficulty,
            seed=args.seed,
            **advanced_params
        ):
            print("❌ Data generation failed!")
            sys.exit(1)
        
        # Organize files (copy to target locations)
        print("\n📁 Organizing generated files...")
        if not organize_generated_files(task_root):
            print("❌ File organization failed!")
            sys.exit(1)
        
        # Generate groundtruth (after files are organized)
        if not generate_groundtruth(task_root):
            print("❌ Groundtruth generation failed!")
            sys.exit(1)
    else:
        print("\n" + "=" * 60)
        print("STEP 0: Skip Data Generation")
        print("=" * 60)
        print("Using existing data files")
    
    # Determine CSV file path
    if args.csv_file:
        csv_file_path = args.csv_file
    else:
        # Default path (generated file location in task_root)
        csv_file_path = str(task_root / "files" / "machine_operating" / "live_sensor.csv")
    
    print(f"\n📄 CSV file path: {csv_file_path}")
    
    # Verify CSV file exists
    if not os.path.exists(csv_file_path):
        print(f"❌ CSV file not found: {csv_file_path}")
        print("   Run without --skip-generation to generate data first")
        sys.exit(1)
    
    # Step 1: Clean BigQuery dataset
    print("\n" + "=" * 60)
    print("STEP 1: Clean BigQuery Dataset")
    print("=" * 60)
    if not clean_dataset(gcloud_db, project_id, "machine_operating"):
        print("❌ Dataset cleanup failed!")
        sys.exit(1)
    
    # Step 2: Clean Cloud Storage bucket
    print("\n" + "=" * 60)
    print("STEP 2: Clean Cloud Storage Bucket")
    print("=" * 60)
    if not clean_bucket(gcloud_db, "iot_anomaly_reports"):
        print("❌ Bucket cleanup failed!")
        sys.exit(1)
    
    # Wait message (not actually waiting since we're using local DB)
    print("\n" + "=" * 60)
    print("⏳ Configuration complete (no wait needed for local DB)")
    print("=" * 60)
    
    # Step 3: Upload CSV file to BigQuery
    print("\n" + "=" * 60)
    print("STEP 3: Upload CSV File to BigQuery")
    print("=" * 60)
    
    if not upload_csv_to_bigquery(
        db=gcloud_db,
        project_id=project_id,
        dataset_id="machine_operating",
        csv_file_path=csv_file_path,
        table_name="live_sensor"
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
    
    print("\n" + "=" * 60)
    print("🎉 Machine Operating Task Environment Preprocessing Complete!")
    print("=" * 60)
    print(f"✅ Google Cloud database initialized")
    print(f"✅ BigQuery dataset 'machine_operating' created and populated")
    print(f"✅ Cloud Storage bucket cleaned")
    
    # Count tables
    tables = gcloud_db.list_bigquery_tables(project_id, "machine_operating")
    print(f"\n📊 Dataset Statistics:")
    print(f"   Tables created: {len(tables)}")
    for table in tables:
        print(f"      - {table['tableId']}: {table.get('numRows', 0)} rows")
    
    # Display generated files information
    if not args.skip_generation:
        print(f"\n📁 Generated Files:")
        
        # Check sensor data
        sensor_file = task_root / "files" / "machine_operating" / "live_sensor.csv"
        if sensor_file.exists():
            import csv
            with open(sensor_file, 'r') as f:
                row_count = sum(1 for row in csv.DictReader(f))
            print(f"   - live_sensor.csv: {row_count:,} rows")
        
        # Check parameters file
        params_file = task_root / "initial_workspace" / "machine_operating_parameters.xlsx"
        if params_file.exists():
            import pandas as pd
            df = pd.read_excel(params_file)
            print(f"   - machine_operating_parameters.xlsx: {len(df)} configurations")
        
        # Check groundtruth
        gt_file = task_root / "groundtruth_workspace" / "anomaly_report.csv"
        if gt_file.exists():
            with open(gt_file, 'r') as f:
                gt_count = sum(1 for row in csv.DictReader(f))
            print(f"   - anomaly_report.csv (groundtruth): {gt_count} anomalies")
    
    print(f"\n📂 Directory Locations:")
    print(f"   Task Root: {task_root}")
    print(f"   Google Cloud DB: {gcloud_db_dir}")
    print(f"   Sensor Data: {task_root / 'files' / 'machine_operating' / 'live_sensor.csv'}")
    print(f"   Initial Workspace: {task_root / 'initial_workspace'}")
    print(f"   Groundtruth Workspace: {task_root / 'groundtruth_workspace'}")
    if args.agent_workspace:
        print(f"   Agent Workspace: {args.agent_workspace}")
    
    print(f"\n📌 Environment Variables:")
    print(f"   GOOGLE_CLOUD_DATA_DIR={gcloud_db_dir}")
    
    print(f"\n💡 Next Step: Agent can now use google-cloud-simplified MCP server")
    print(f"   to query BigQuery table 'machine_operating.live_sensor'")
    print(f"   and detect anomalies based on machine_operating_parameters.xlsx")
