#!/usr/bin/env python3
"""
Machine Operating Anomaly Detection Task Evaluation Script

Verify the match between agent-generated anomaly_report.csv and groundtruth
"""

from argparse import ArgumentParser
import os
import sys
import json
import pandas as pd
from datetime import datetime, timedelta
import math
import tempfile
from pathlib import Path



from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase


def get_gcloud_data_directory(agent_workspace: str) -> str:
    """Determine Google Cloud database directory based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
    return gcloud_db_dir

def download_from_storage_bucket(db: GoogleCloudDatabase, bucket_name: str, file_name: str, local_path: str) -> bool:
    """Retrieve file content from local database storage bucket and save locally"""
    try:
        print(f"📥 Retrieving {file_name} from bucket {bucket_name} (local db)...")
        
        # Get object from storage bucket
        obj = db.get_storage_object(bucket_name, file_name)
        
        if not obj:
            print(f"❌ File {file_name} not found in bucket {bucket_name}")
            return False
        
        # Get content
        content = obj.get("content", "")
        
        if not content:
            print(f"⚠️  Warning: File content is empty")
            return False
        
        # Write content to local file
        with open(local_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        # Verify written file
        if os.path.exists(local_path):
            file_size = os.path.getsize(local_path)
            print(f"✅ Successfully retrieved {file_name} ({file_size} bytes)")
            
            # Check if file appears to be CSV
            try:
                with open(local_path, 'r', encoding='utf-8') as f:
                    first_line = f.readline().strip()
                    if ',' in first_line or 'timestamp' in first_line.lower():
                        print(f"✅ File appears to be CSV format")
                    else:
                        print(f"⚠️  Warning: File may not be CSV format")
                        print(f"📄 First line: {first_line[:100]}...")
            except Exception as e:
                print(f"⚠️  Warning: Could not read file: {e}")
            
            return True
        else:
            print(f"❌ Failed to write file to {local_path}")
            return False
    
    except Exception as e:
        print(f"❌ Error retrieving {file_name}: {e}")
        return False


def check_storage_bucket_exists(db: GoogleCloudDatabase, bucket_name: str) -> bool:
    """Check if Google Cloud Storage bucket exists (local database)"""
    try:
        bucket = db.get_storage_bucket(bucket_name)
        if bucket:
            print(f"✅ Found bucket '{bucket_name}' in local database")
            return True
        else:
            print(f"❌ Bucket '{bucket_name}' not found in local database")
            return False
    except Exception as e:
        print(f"❌ Error checking bucket in local database: {e}")
        return False


def check_file_exists_in_bucket(db: GoogleCloudDatabase, bucket_name: str, file_name: str) -> bool:
    """Check if file exists in Google Cloud Storage bucket (local database)"""
    try:
        obj = db.get_storage_object(bucket_name, file_name)
        return obj is not None
    except Exception:
        return False

def load_csv_file(file_path: str, file_type: str = "CSV") -> pd.DataFrame:
    """Load CSV file"""
    try:
        print(f"📖 Loading {file_type} from: {file_path}")
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"{file_type} file not found: {file_path}")
        
        df = pd.read_csv(file_path)
        print(f"✅ {file_type} loaded: {len(df)} records, {len(df.columns)} columns")
        print(f"📊 Columns: {list(df.columns)}")
        
        # Display data overview
        if len(df) > 0:
            print(f"📄 First few records:")
            print(df.head(3).to_string(index=False))
        
        return df
        
    except Exception as e:
        raise ValueError(f"Failed to load {file_type} file {file_path}: {e}")

def normalize_timestamp(timestamp_str: str) -> datetime:
    """Normalize timestamp format"""
    # Clean timestamp string
    cleaned_timestamp = timestamp_str.strip()

    # Process timezone information - remove timezone suffixes like +00:00, +08:00
    if '+' in cleaned_timestamp:
        cleaned_timestamp = cleaned_timestamp.split('+')[0]
    elif cleaned_timestamp.endswith('Z'):
        cleaned_timestamp = cleaned_timestamp[:-1]  # Remove UTC marker 'Z'
    elif cleaned_timestamp.endswith(' UTC'):
        cleaned_timestamp = cleaned_timestamp[:-4]  # Remove UTC marker ' UTC'

    # Try different time formats
    time_formats = [
        '%Y-%m-%d %H:%M:%S.%f',     # 2025-08-19 11:52:08.269059
        '%Y-%m-%d %H:%M:%S',        # 2025-08-19 11:52:08
        '%Y-%m-%d %H:%M',           # 2025-08-19 11:52
        '%Y-%m-%dT%H:%M:%S.%f',     # 2025-08-19T11:52:08.269059 (ISO format)
        '%Y-%m-%dT%H:%M:%S',        # 2025-08-19T11:52:08 (ISO format)
    ]
    
    for fmt in time_formats:
        try:
            return datetime.strptime(cleaned_timestamp, fmt)
        except ValueError:
            continue
    
    raise ValueError(f"Could not parse timestamp: {timestamp_str} (cleaned: {cleaned_timestamp})")

def normalize_reading_value(reading_str) -> float:
    """Normalize reading value"""
    try:
        if isinstance(reading_str, (int, float)):
            return float(reading_str)
        
        # Remove possible spaces and units
        cleaned = str(reading_str).strip()
        return float(cleaned)
    except (ValueError, TypeError):
        raise ValueError(f"Could not parse reading value: {reading_str}")

def create_record_key(row: pd.Series, time_tolerance_seconds: int = 60) -> tuple:
    """Create record identifier key for matching"""
    try:
        timestamp = normalize_timestamp(str(row['timestamp']))
        machine_id = str(row['machine_id']).strip()
        sensor_type = str(row['sensor_type']).strip()
        reading = normalize_reading_value(row['reading'])
        
        # Round timestamp down to specified tolerance (default 1 minute)
        # This handles timestamp precision issues
        rounded_timestamp = timestamp.replace(second=0, microsecond=0)
        if time_tolerance_seconds >= 60:
            rounded_timestamp = rounded_timestamp.replace(minute=rounded_timestamp.minute // (time_tolerance_seconds // 60) * (time_tolerance_seconds // 60))
        
        return (rounded_timestamp, machine_id, sensor_type, reading)
    except Exception as e:
        raise ValueError(f"Error creating key for row: {row.to_dict()}, error: {e}")

def values_approximately_equal(val1: float, val2: float, tolerance: float = 0.01) -> bool:
    """Check if two values are equal within tolerance range"""
    return abs(val1 - val2) <= tolerance

def find_matching_records(agent_row: pd.Series, groundtruth_df: pd.DataFrame, 
                         time_tolerance_seconds: int = 60, reading_tolerance: float = 0.01) -> list:
    """Find matching records in groundtruth"""
    matches = []
    
    try:
        agent_timestamp = normalize_timestamp(str(agent_row['timestamp']))
        agent_machine_id = str(agent_row['machine_id']).strip()
        agent_sensor_type = str(agent_row['sensor_type']).strip()
        agent_reading = normalize_reading_value(agent_row['reading'])
        
        for idx, gt_row in groundtruth_df.iterrows():
            try:
                gt_timestamp = normalize_timestamp(str(gt_row['timestamp']))
                gt_machine_id = str(gt_row['machine_id']).strip()
                gt_sensor_type = str(gt_row['sensor_type']).strip()
                gt_reading = normalize_reading_value(gt_row['reading'])
                
                # Check time difference
                time_diff = abs((agent_timestamp - gt_timestamp).total_seconds())

                # Check if all fields match
                if (time_diff <= time_tolerance_seconds and
                    agent_machine_id == gt_machine_id and
                    agent_sensor_type == gt_sensor_type and
                    values_approximately_equal(agent_reading, gt_reading, reading_tolerance)):

                    matches.append({
                        'groundtruth_index': idx,
                        'time_diff_seconds': time_diff,
                        'reading_diff': abs(agent_reading - gt_reading),
                        'groundtruth_row': gt_row
                    })
            except Exception as e:
                # Skip groundtruth records that cannot be parsed
                continue
                
    except Exception as e:
        print(f"⚠️ Error processing agent row: {e}")
        return []

    # Sort by time difference and reading difference, return best match
    matches.sort(key=lambda x: (x['time_diff_seconds'], x['reading_diff']))
    return matches

def validate_anomaly_reports(agent_file: str, groundtruth_file: str, 
                           time_tolerance_seconds: int = 60, 
                           reading_tolerance: float = 0.01) -> dict:
    """Verify anomaly report matching (bidirectional validation)"""
    print("🔍 Validating anomaly reports (bidirectional)...")
    
    # Load data
    agent_df = load_csv_file(agent_file, "Agent anomaly report")
    groundtruth_df = load_csv_file(groundtruth_file, "Groundtruth anomaly report")
    
    # Verify required columns exist
    required_columns = ['timestamp', 'machine_id', 'sensor_type', 'reading']
    
    for col in required_columns:
        if col not in agent_df.columns:
            raise ValueError(f"Missing required column '{col}' in agent report")
        if col not in groundtruth_df.columns:
            raise ValueError(f"Missing required column '{col}' in groundtruth report")
    
    print(f"📊 Validation parameters:")
    print(f"   Time tolerance: {time_tolerance_seconds} seconds")
    print(f"   Reading tolerance: {reading_tolerance}")
    
    # Initialize validation results
    validation_results = {
        'total_agent_records': len(agent_df),
        'total_groundtruth_records': len(groundtruth_df),


        # Agent -> Groundtruth validation (Precision)
        'agent_matched_records': 0,
        'agent_unmatched_records': 0,
        'agent_match_details': [],
        'agent_unmatched_details': [],

        # Groundtruth -> Agent validation (Recall)
        'gt_matched_records': 0,
        'gt_unmatched_records': 0,
        'gt_match_details': [],
        'gt_unmatched_details': [],
        
        'validation_errors': []
    }
    
    # === Step 1: Verify if agent records can be found in groundtruth (Precision) ===
    print(f"\n🔍 Step 1: Validating agent records against groundtruth (Precision)...")
    print(f"   Checking {len(agent_df)} agent records against {len(groundtruth_df)} groundtruth records...")
    
    used_gt_indices = set()  # Track matched groundtruth indices
    
    for idx, agent_row in agent_df.iterrows():
        try:
            matches = find_matching_records(agent_row, groundtruth_df, time_tolerance_seconds, reading_tolerance)
            
            if matches:
                best_match = matches[0]
                validation_results['agent_matched_records'] += 1
                used_gt_indices.add(best_match['groundtruth_index'])
                
                validation_results['agent_match_details'].append({
                    'agent_index': idx,
                    'agent_timestamp': str(agent_row['timestamp']),
                    'agent_machine_id': str(agent_row['machine_id']),
                    'agent_sensor_type': str(agent_row['sensor_type']),
                    'agent_reading': agent_row['reading'],
                    'groundtruth_index': best_match['groundtruth_index'],
                    'time_diff_seconds': best_match['time_diff_seconds'],
                    'reading_diff': best_match['reading_diff']
                })
                
                if idx < 5:  # Show details of first 5 matches
                    print(f"✅ Agent->GT Match {idx+1}: Agent [{agent_row['timestamp']}, {agent_row['machine_id']}, {agent_row['sensor_type']}, {agent_row['reading']}] "
                          f"-> GT [time_diff: {best_match['time_diff_seconds']:.1f}s, reading_diff: {best_match['reading_diff']:.3f}]")
            else:
                validation_results['agent_unmatched_records'] += 1
                validation_results['agent_unmatched_details'].append({
                    'agent_index': idx,
                    'agent_timestamp': str(agent_row['timestamp']),
                    'agent_machine_id': str(agent_row['machine_id']),
                    'agent_sensor_type': str(agent_row['sensor_type']),
                    'agent_reading': agent_row['reading']
                })

                if len(validation_results['agent_unmatched_details']) <= 5:  # Show details of first 5 unmatched
                    print(f"❌ Agent unmatched {len(validation_results['agent_unmatched_details'])}: Agent [{agent_row['timestamp']}, {agent_row['machine_id']}, {agent_row['sensor_type']}, {agent_row['reading']}]")
                    
        except Exception as e:
            error_msg = f"Error processing agent record {idx}: {e}"
            validation_results['validation_errors'].append(error_msg)
            print(f"⚠️ {error_msg}")
    
    # === Step 2: Verify if groundtruth records can be found in agent (Recall) ===
    print(f"\n🔍 Step 2: Validating groundtruth records against agent (Recall)...")
    print(f"   Checking {len(groundtruth_df)} groundtruth records against {len(agent_df)} agent records...")
    
    for idx, gt_row in groundtruth_df.iterrows():
        try:
            matches = find_matching_records(gt_row, agent_df, time_tolerance_seconds, reading_tolerance)
            
            if matches:
                best_match = matches[0]
                validation_results['gt_matched_records'] += 1
                
                validation_results['gt_match_details'].append({
                    'groundtruth_index': idx,
                    'groundtruth_timestamp': str(gt_row['timestamp']),
                    'groundtruth_machine_id': str(gt_row['machine_id']),
                    'groundtruth_sensor_type': str(gt_row['sensor_type']),
                    'groundtruth_reading': gt_row['reading'],
                    'agent_index': best_match['groundtruth_index'],
                    'time_diff_seconds': best_match['time_diff_seconds'],
                    'reading_diff': best_match['reading_diff']
                })
                
                if idx < 5:  # Show details of first 5 matches
                    print(f"✅ GT->Agent Match {idx+1}: GT [{gt_row['timestamp']}, {gt_row['machine_id']}, {gt_row['sensor_type']}, {gt_row['reading']}] "
                          f"-> Agent [time_diff: {best_match['time_diff_seconds']:.1f}s, reading_diff: {best_match['reading_diff']:.3f}]")
            else:
                validation_results['gt_unmatched_records'] += 1
                validation_results['gt_unmatched_details'].append({
                    'groundtruth_index': idx,
                    'groundtruth_timestamp': str(gt_row['timestamp']),
                    'groundtruth_machine_id': str(gt_row['machine_id']),
                    'groundtruth_sensor_type': str(gt_row['sensor_type']),
                    'groundtruth_reading': gt_row['reading']
                })
                
                if len(validation_results['gt_unmatched_details']) <= 5:  # Show details of first 5 unmatched
                    print(f"❌ GT unmatched {len(validation_results['gt_unmatched_details'])}: GT [{gt_row['timestamp']}, {gt_row['machine_id']}, {gt_row['sensor_type']}, {gt_row['reading']}]")
                    
        except Exception as e:
            error_msg = f"Error processing groundtruth record {idx}: {e}"
            validation_results['validation_errors'].append(error_msg)
            print(f"⚠️ {error_msg}")
    
    return validation_results

def generate_validation_summary(results: dict) -> bool:
    """Generate validation summary (bidirectional validation)"""
    print(f"\n" + "="*80)
    print(f"📊 ANOMALY DETECTION VALIDATION SUMMARY (BIDIRECTIONAL)")
    print(f"="*80)
    
    total_agent = results['total_agent_records']
    total_gt = results['total_groundtruth_records']
    errors = len(results['validation_errors'])
    
    # Agent -> Groundtruth validation results (Precision)
    agent_matched = results['agent_matched_records']
    agent_unmatched = results['agent_unmatched_records']
    precision = (agent_matched / total_agent * 100) if total_agent > 0 else 0

    # Groundtruth -> Agent validation results (Recall)
    gt_matched = results['gt_matched_records']
    gt_unmatched = results['gt_unmatched_records']
    recall = (gt_matched / total_gt * 100) if total_gt > 0 else 0
    
    # F1 Score
    f1_score = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0
    
    print(f"📈 Overall Statistics:")
    print(f"   Total agent records: {total_agent}")
    print(f"   Total groundtruth records: {total_gt}")
    print(f"   Validation errors: {errors}")
    print()
    
    print(f"🎯 Precision Analysis (Agent -> Groundtruth):")
    print(f"   Agent records matched in GT: {agent_matched}/{total_agent}")
    print(f"   Agent records NOT in GT: {agent_unmatched}")
    print(f"   Precision: {precision:.1f}%")
    print()
    
    print(f"🔍 Recall Analysis (Groundtruth -> Agent):")
    print(f"   GT records found by agent: {gt_matched}/{total_gt}")
    print(f"   GT records MISSED by agent: {gt_unmatched}")
    print(f"   Recall: {recall:.1f}%")
    print()
    
    print(f"⚖️ Combined Metrics:")
    print(f"   F1 Score: {f1_score:.1f}%")
    
    # Show unmatched agent records (False Positives)
    if agent_unmatched > 0:
        print(f"\n❌ Agent records NOT found in groundtruth (False Positives, first 10):")
        for i, detail in enumerate(results['agent_unmatched_details'][:10]):
            print(f"   {i+1}. [{detail['agent_timestamp']}, {detail['agent_machine_id']}, "
                  f"{detail['agent_sensor_type']}, {detail['agent_reading']}]")
        
        if len(results['agent_unmatched_details']) > 10:
            print(f"   ... and {len(results['agent_unmatched_details']) - 10} more")
    
    # Show unmatched groundtruth records (False Negatives)
    if gt_unmatched > 0:
        print(f"\n❌ Groundtruth records MISSED by agent (False Negatives, first 10):")
        for i, detail in enumerate(results['gt_unmatched_details'][:10]):
            print(f"   {i+1}. [{detail['groundtruth_timestamp']}, {detail['groundtruth_machine_id']}, "
                  f"{detail['groundtruth_sensor_type']}, {detail['groundtruth_reading']}]")
        
        if len(results['gt_unmatched_details']) > 10:
            print(f"   ... and {len(results['gt_unmatched_details']) - 10} more")
    
    # Show validation errors
    if errors > 0:
        print(f"\n⚠️ Validation errors (first 5):")
        for i, error in enumerate(results['validation_errors'][:5]):
            print(f"   {i+1}. {error}")
    
    # Determine if validation passes
    # Requirements: Precision ≥ 95%, Recall ≥ 90%, no validation errors
    print(f"\n🏆 EVALUATION CRITERIA:")
    print(f"   Precision requirement: ≥100% (no false positives)")
    print(f"   Recall requirement: ≥100% (minimal false negatives)")
    print(f"   Error requirement: 0 validation errors")
    
    if precision >= 100.0 and recall >= 100.0 and errors == 0:
        print(f"\n🎉 VALIDATION PASSED!")
        print(f"   ✅ Precision {precision:.1f}% meets requirement (≥100%)")
        print(f"   ✅ Recall {recall:.1f}% meets requirement (≥100%)")
        print(f"   ✅ No validation errors")
        print(f"   ✅ F1 Score: {f1_score:.1f}%")
        return True
    elif precision >= 100.0 and recall >= 100.0:
        print(f"\n⚠️ VALIDATION PARTIAL PASS")
        if precision < 100.0:
            print(f"   ⚠️ Precision {precision:.1f}% below optimal (≥100%)")
        if recall < 100.0:
            print(f"   ⚠️ Recall {recall:.1f}% below optimal (≥100%)")
        if errors > 0:
            print(f"   ⚠️ {errors} validation errors detected")
        print(f"   📊 F1 Score: {f1_score:.1f}%")
        return True
    else:
        print(f"\n❌ VALIDATION FAILED!")
        if precision < 100.0:
            print(f"   ❌ Precision {precision:.1f}% below minimum requirement (≥100%)")
        if recall < 100.0:
            print(f"   ❌ Recall {recall:.1f}% below minimum requirement (≥100%)")
        if errors > 0:
            print(f"   ❌ {errors} validation errors detected")
        print(f"   📊 F1 Score: {f1_score:.1f}%")
        return False

def find_anomaly_report_files(workspace_dir: str) -> list:
    """Find anomaly report files in workspace"""
    anomaly_files = []
    
    if not os.path.exists(workspace_dir):
        return anomaly_files
        
    for file in os.listdir(workspace_dir):
        if 'anomaly_report' in file and file.endswith('.csv'):
            file_path = os.path.join(workspace_dir, file)
            file_size = os.path.getsize(file_path)
            anomaly_files.append({
                'filename': file,
                'filepath': file_path,
                'size_kb': file_size / 1024
            })
    
    return anomaly_files

def find_anomaly_report_in_bucket(db: GoogleCloudDatabase, bucket_name: str = "iot_anomaly_reports", 
                                  file_pattern: str = "anomaly_report") -> str:
    """Find anomaly report files matching pattern in storage bucket (local database)"""
    print(f"🔍 Searching for anomaly reports in bucket: {bucket_name}/{file_pattern}*.csv")
    
    try:
        # List all objects in the bucket
        objects = db.list_storage_objects(bucket_name)
        
        # Find matching files
        matching_files = []
        for obj in objects:
            obj_name = obj.get('name', '')
            if obj_name.startswith(file_pattern) and obj_name.endswith('.csv'):
                matching_files.append(obj_name)
        
        if not matching_files:
            raise ValueError(f"No anomaly report files found matching pattern '{file_pattern}*.csv' in bucket {bucket_name}")
        
        print(f"📄 Found {len(matching_files)} matching file(s):")
        for i, file_name in enumerate(matching_files):
            print(f"   {i+1}. {file_name}")
        
        # Select the last one (most recent by timestamp usually)
        selected_file = sorted(matching_files)[-1]
        print(f"📄 Selected file: {selected_file}")
        
        return selected_file
    
    except Exception as e:
        raise ValueError(f"Error searching for anomaly reports: {e}")


def validate_task_completion(db: GoogleCloudDatabase, bucket_name: str = "iot_anomaly_reports",
                             file_pattern: str = "anomaly_report") -> str:
    """Verify if task was completed correctly, retrieve agent-uploaded anomaly_report file from local db"""
    print("🔍 Checking task completion...")
    
    # Check if storage bucket exists
    if not check_storage_bucket_exists(db, bucket_name):
        raise ValueError(f"Storage bucket '{bucket_name}' not found")
    print(f"✅ Storage bucket '{bucket_name}' exists")
    
    # Find matching anomaly report file
    file_name = find_anomaly_report_in_bucket(db, bucket_name, file_pattern)
    print(f"✅ Anomaly report file '{file_name}' found in bucket")
    
    # Preview file content
    print(f"🔍 Checking file content in bucket...")
    try:
        obj = db.get_storage_object(bucket_name, file_name)
        if obj:
            content = obj.get("content", "")
            preview = content[:500] if len(content) > 500 else content
            print(f"📄 File preview (first 500 bytes): {preview[:200]}...")
            if ',' not in preview[:100] and 'timestamp' not in preview.lower():
                print(f"⚠️  Warning: File content doesn't look like CSV")
    except Exception as e:
        print(f"⚠️  Could not preview file: {e}")
    
    # Download file for validation
    with tempfile.NamedTemporaryFile(mode='w+', suffix='.csv', delete=False) as tmp_file:
        temp_path = tmp_file.name
    
    try:
        if not download_from_storage_bucket(db, bucket_name, file_name, temp_path):
            raise ValueError(f"Failed to retrieve {file_name} from bucket {bucket_name}")
        
        return temp_path
        
    except Exception as e:
        # Clean up temp file
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise e

if __name__ == "__main__":
    parser = ArgumentParser(description="Machine Operating Anomaly Detection Task Evaluation")
    parser.add_argument("--agent_workspace", required=True, help="Agent workspace directory")
    parser.add_argument("--groundtruth_workspace", required=True, help="Groundtruth workspace directory")  
    parser.add_argument("--res_log_file", required=True, help="Result log file path")
    parser.add_argument("--time_tolerance", type=int, default=60, help="Time tolerance in seconds (default: 60)")
    parser.add_argument("--reading_tolerance", type=float, default=0.01, help="Reading value tolerance (default: 0.01)")
    parser.add_argument("--bucket_name", default="iot_anomaly_reports", help="Storage bucket name (default: iot_anomaly_reports)")
    parser.add_argument("--file_pattern", default="anomaly_report", help="Anomaly report file pattern (default: anomaly_report, matches anomaly_report*.csv)")
    parser.add_argument("--test_mode", action="store_true", help="Enable test mode (use local files instead of storage bucket)")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("Machine Operating Anomaly Detection Evaluation")
    print("=" * 60)
    print(f"Agent workspace: {args.agent_workspace}")
    print(f"Groundtruth workspace: {args.groundtruth_workspace}")
    print(f"Storage bucket: {args.bucket_name}")
    print(f"Target file pattern: {args.file_pattern}*.csv")
    print(f"Test mode: {args.test_mode}")
    print(f"Time tolerance: {args.time_tolerance}s")
    print(f"Reading tolerance: {args.reading_tolerance}")
    
    # Initialize Google Cloud Database
    print("\n📊 Initializing Google Cloud Database for evaluation...")
    gcloud_db_dir = get_gcloud_data_directory(args.agent_workspace)
    print(f"📂 Using Google Cloud Database Directory: {gcloud_db_dir}")
    
    if not Path(gcloud_db_dir).exists():
        print(f"❌ Error: Google Cloud database directory not found: {gcloud_db_dir}")
        print("   Please run preprocessing first to initialize the database.")
        sys.exit(1)
    
    gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)
    
    temp_agent_file = None
    
    try:
        if args.test_mode:
            # Test mode: Use local files from agent workspace
            print("\n🧪 Test mode: Using local files from agent workspace")
            agent_anomaly_files = find_anomaly_report_files(args.agent_workspace)
            
            if not agent_anomaly_files:
                raise FileNotFoundError(f"No anomaly report files found in agent workspace: {args.agent_workspace}")
            
            print(f"\n📁 Found {len(agent_anomaly_files)} anomaly report file(s) in agent workspace:")
            for i, file_info in enumerate(agent_anomaly_files):
                print(f"   {i+1}. {file_info['filename']} ({file_info['size_kb']:.1f}KB)")
            
            # Use the first found file
            agent_file = agent_anomaly_files[0]['filepath']
            print(f"📄 Using local agent file: {agent_file}")
        else:
            # Production mode: Retrieve from local database storage bucket
            print("\n🏭 Production mode: Retrieving from local database storage bucket")
            temp_agent_file = validate_task_completion(gcloud_db, args.bucket_name, args.file_pattern)
            agent_file = temp_agent_file
            print(f"📄 Using retrieved agent file: {agent_file}")
        
        # Find groundtruth file
        print("\n📄 Locating groundtruth file...")
        groundtruth_file = None
        
        # First try in groundtruth_workspace
        if args.groundtruth_workspace:
            gt_anomaly_files = find_anomaly_report_files(args.groundtruth_workspace)
            if gt_anomaly_files:
                groundtruth_file = gt_anomaly_files[0]['filepath']
                print(f"✅ Using groundtruth file: {groundtruth_file}")
        
        if not groundtruth_file:
            # Try relative paths from current directory
            task_root = Path(__file__).parent.parent
            possible_paths = [
                task_root / "groundtruth_workspace" / "anomaly_report.csv",
                Path(args.groundtruth_workspace) / "anomaly_report.csv" if args.groundtruth_workspace else None,
            ]
            
            for path in possible_paths:
                if path and path.exists():
                    groundtruth_file = str(path)
                    print(f"✅ Found groundtruth file: {groundtruth_file}")
                    break
        
        if not groundtruth_file:
            raise FileNotFoundError(f"Could not find groundtruth anomaly report file. Tried: {args.groundtruth_workspace}")


        # Execute validation
        validation_results = validate_anomaly_reports(
            agent_file,
            groundtruth_file,
            args.time_tolerance,
            args.reading_tolerance
        )

        # Generate validation summary
        validation_passed = generate_validation_summary(validation_results)

        # Validate log file
        if not os.path.isfile(args.res_log_file):
            raise FileNotFoundError(f"Missing log file: {args.res_log_file}")
        
        with open(args.res_log_file, "r", encoding="utf-8") as f:
            log_data = json.load(f)
        
        messages = log_data.get("messages")
        if not isinstance(messages, list):
            raise ValueError("Log file missing 'messages' list")
        
        # Final results
        if validation_passed:
            print(f"\n" + "=" * 60)
            print(f"🎉 Machine Operating Anomaly Detection Evaluation PASSED!")
            print(f"=" * 60)
            print(f"✅ Anomaly report matching pattern '{args.file_pattern}*.csv' correctly uploaded to bucket '{args.bucket_name}'")
            print(f"✅ All bidirectional validations completed successfully")
            print(f"✅ Precision and Recall both meet 100% requirement")
            sys.exit(0)
        else:
            print(f"\n" + "=" * 60)
            print(f"❌ Machine Operating Anomaly Detection Evaluation FAILED!")
            print(f"=" * 60)
            sys.exit(1)
        
    except Exception as e:
        print(f"\n❌ Evaluation failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
        
    finally:
        # Clean up temporary files
        if temp_agent_file and os.path.exists(temp_agent_file):
            os.unlink(temp_agent_file)
            print(f"🧹 Cleaned up temporary file: {temp_agent_file}")
