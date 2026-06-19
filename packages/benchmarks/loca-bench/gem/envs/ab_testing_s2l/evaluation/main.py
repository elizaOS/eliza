from argparse import ArgumentParser
import os
import csv
import json
import ast
import sys
from pathlib import Path



from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase

# # Import GoogleCloudDatabase from gem project
# from gem.tools.mcp_server.google_cloud.database import GoogleCloudDatabase

def read_record_csv(csv_path: str) -> dict:
    """Read record.csv file and return a dictionary of scenarios and conversion rates"""
    if not os.path.isfile(csv_path):
        raise FileNotFoundError(f"Missing record.csv file: {csv_path}")
    
    records = {}
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError(f"File {csv_path} must contain headers")
        
        required_fields = ["scenario", "A_conversion %", "B_conversion %"]
        for field in required_fields:
            if field not in reader.fieldnames:
                raise ValueError(f"File {csv_path} must contain '{field}' column. Found: {reader.fieldnames}")
        
        for row in reader:
            scenario = (row.get("scenario") or "").strip()
            a_rate_str = (row.get("A_conversion %") or "").strip()
            b_rate_str = (row.get("B_conversion %") or "").strip()
            
            if not scenario:
                raise ValueError("Empty scenario found in record.csv")
            if not a_rate_str:
                raise ValueError(f"Empty A conversion rate for scenario {scenario}")
            if not b_rate_str:
                raise ValueError(f"Empty B conversion rate for scenario {scenario}")
            
            try:
                # Parse percentage values (remove % sign if present)
                a_rate = float(a_rate_str.replace('%', ''))
                b_rate = float(b_rate_str.replace('%', ''))
            except ValueError:
                raise ValueError(f"Invalid conversion rates for scenario {scenario}: A='{a_rate_str}', B='{b_rate_str}'")
            
            records[scenario] = {'A': a_rate, 'B': b_rate}
    
    return records

def load_expected_records(groundtruth_workspace: str) -> dict:
    """Load expected record data from groundtruth workspace"""
    expected_file = os.path.join(groundtruth_workspace, "expected_ratio.csv")
    return read_record_csv(expected_file)

def normalize_scenario_name(scenario: str) -> str:
    """Normalize scenario name by removing 'ab_' prefix if present"""
    if scenario.startswith('ab_'):
        return scenario[3:]
    return scenario

def validate_record_data(actual_records: dict, expected_records: dict, tolerance_pct: float = 0.1) -> None:
    """Validate if all conversion rates in record.csv match expected values within tolerance
    
    This function is flexible with scenario naming - it accepts scenarios with or without 'ab_' prefix.
    """
    validation_errors = []
    
    # Normalize scenario names for comparison
    normalized_expected = {normalize_scenario_name(k): v for k, v in expected_records.items()}
    normalized_actual = {normalize_scenario_name(k): v for k, v in actual_records.items()}
    
    # Check if all expected scenarios are present
    expected_scenarios = set(normalized_expected.keys())
    actual_scenarios = set(normalized_actual.keys())
    
    missing_scenarios = expected_scenarios - actual_scenarios
    extra_scenarios = actual_scenarios - expected_scenarios
    
    if missing_scenarios:
        validation_errors.append(f"Missing scenarios: {sorted(missing_scenarios)}")
    if extra_scenarios:
        validation_errors.append(f"Unexpected scenarios: {sorted(extra_scenarios)}")
    
    # Validate conversion rates for each scenario
    validated_count = 0
    for scenario in expected_scenarios & actual_scenarios:
        expected_A = normalized_expected[scenario]['A']
        expected_B = normalized_expected[scenario]['B']
        actual_A = normalized_actual[scenario]['A']
        actual_B = normalized_actual[scenario]['B']
        
        # Check A conversion rate
        diff_A = abs(actual_A - expected_A)
        if diff_A > tolerance_pct:
            validation_errors.append(
                f"Scenario '{scenario}' Version A: expected {expected_A:.3f}%±{tolerance_pct}%, got {actual_A:.3f}% (diff: {diff_A:.3f}%)"
            )
        
        # Check B conversion rate
        diff_B = abs(actual_B - expected_B)
        if diff_B > tolerance_pct:
            validation_errors.append(
                f"Scenario '{scenario}' Version B: expected {expected_B:.3f}%±{tolerance_pct}%, got {actual_B:.3f}% (diff: {diff_B:.3f}%)"
            )
        
        validated_count += 1
    
    if validation_errors:
        error_msg = '\n'.join(validation_errors)
        raise ValueError(f"Record validation failed:\n{error_msg}")
    
    print(f"✅ All {validated_count} scenarios validated successfully with {tolerance_pct}% tolerance")

def get_gcloud_data_directory(agent_workspace: str) -> str:
    """Determine Google Cloud database directory based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
    return gcloud_db_dir

def check_storage_bucket_exists(db: GoogleCloudDatabase, bucket_name: str) -> bool:
    """Check if Google Cloud Storage bucket exists in local database"""
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

def check_abtesting_logging_entry(db: GoogleCloudDatabase, expected_message: dict) -> bool:
    """Check that abtesting_logging contains the expected log entry
    
    Supports two methods:
    1. New: Cloud Logging API (db.list_log_entries) - preferred
    2. Legacy: Cloud Storage bucket (db.list_storage_objects) - fallback
    """
    try:
        method_used = None
        
        # Method 1: Try Cloud Logging API first (new method)
        try:
            log_entries = db.list_log_entries(
                filter_string='logName="abtesting_logging"',
                max_results=100
            )
            
            if log_entries:
                print(f"📝 Found {len(log_entries)} log entries using Cloud Logging API")
                method_used = "Cloud Logging API"
                
                for entry in log_entries:
                    # Get message from json_payload or text_payload
                    json_payload = entry.get("json_payload")
                    text_payload = entry.get("text_payload")
                    
                    log_data = None
                    
                    # Try json_payload first
                    if json_payload and isinstance(json_payload, dict):
                        log_data = json_payload
                    # Then try to parse text_payload
                    elif text_payload:
                        try:
                            # Try JSON format
                            log_data = json.loads(text_payload)
                        except (json.JSONDecodeError, ValueError):
                            # Try Python dict format (single quotes)
                            try:
                                log_data = ast.literal_eval(text_payload)
                            except (ValueError, SyntaxError):
                                print(f"⚠️  Could not parse text_payload: {text_payload[:100]}")
                                continue
                    
                    if log_data and log_data == expected_message:
                        print(f"✅ Found expected log entry: {expected_message}")
                        print(f"   Method: {method_used}")
                        return True
                    elif log_data:
                        print(f"📄 Found log entry but didn't match. Got: {log_data}")
                
                print(f"❌ Expected log entry not found in Cloud Logging. Expected: {expected_message}")
                return False
        except Exception as e:
            print(f"⚠️  Cloud Logging API not available or error: {e}")
        
        # Method 2: Fallback to Storage bucket (legacy method)
        print("Falling back to legacy Storage bucket method...")
        bucket = db.get_storage_bucket("abtesting_logging")
        if not bucket:
            print("❌ abtesting_logging not found in Cloud Logging or Storage bucket")
            return False
        
        # Get all objects in the bucket
        objects = db.list_storage_objects("abtesting_logging")
        if not objects:
            print("❌ No log entries found in abtesting_logging bucket")
            return False
        
        print(f"📝 Found {len(objects)} object(s) in abtesting_logging storage bucket")
        method_used = "Storage Bucket (legacy)"
        
        # Check if any object contains the expected message
        for obj in objects:
            content = obj.get("content", "")
            if not content:
                continue
            
            # Try to parse content - support both JSON and Python dict string formats
            log_data = None
            
            # First try JSON format (double quotes)
            try:
                log_data = json.loads(content)
            except (json.JSONDecodeError, ValueError):
                # Then try Python dict format (single quotes)
                try:
                    log_data = ast.literal_eval(content)
                except (ValueError, SyntaxError):
                    print(f"⚠️  Could not parse content: {content[:100]}")
                    continue
            
            if log_data == expected_message:
                print(f"✅ Found expected log entry: {expected_message}")
                print(f"   Method: {method_used}")
                return True
            else:
                print(f"📄 Found log entry but didn't match. Got: {log_data}")
        
        print(f"❌ Expected log entry not found. Expected: {expected_message}")
        return False
    except Exception as e:
        print(f"❌ Error checking abtesting_logging: {e}")
        return False

def check_abtesting_logging_bucket_clean(db: GoogleCloudDatabase) -> bool:
    """Check that abtesting_logging is clean (no log entries)
    
    Supports two methods:
    1. New: Cloud Logging API (db.list_log_entries) - preferred
    2. Legacy: Cloud Storage bucket (db.list_storage_objects) - fallback
    """
    try:
        # Method 1: Check Cloud Logging API first
        try:
            log_entries = db.list_log_entries(
                filter_string='logName="abtesting_logging"',
                max_results=10  # Just need to check if any exist
            )
            
            if log_entries and len(log_entries) > 0:
                print(f"❌ abtesting_logging is not clean - found {len(log_entries)} log entries (Cloud Logging API)")
                return False
            
            # Check if log name exists but has no entries
            log_names = db.list_log_names()
            if "abtesting_logging" not in log_names:
                print("✅ abtesting_logging is clean (log doesn't exist)")
                return True
            else:
                print("✅ abtesting_logging is clean (no log entries)")
                return True
        except Exception as e:
            print(f"⚠️  Cloud Logging API not available, checking Storage bucket: {e}")
        
        # Method 2: Fallback to Storage bucket (legacy method)
        bucket = db.get_storage_bucket("abtesting_logging")
        if not bucket:
            print("✅ abtesting_logging is clean (Storage bucket doesn't exist)")
            return True
        
        # Get all objects in the bucket
        objects = db.list_storage_objects("abtesting_logging")
        if not objects or len(objects) == 0:
            print("✅ abtesting_logging is clean (no objects in Storage bucket)")
            return True
        else:
            print(f"❌ abtesting_logging is not clean - found {len(objects)} objects in Storage bucket")
            return False
    except Exception as e:
        print(f"❌ Error checking abtesting_logging: {e}")
        return False

def validate_task_completion(db: GoogleCloudDatabase, actual_records: dict) -> None:
    """Validate if task is completed correctly based on A/B test results
    
    Rules:
    - If B wins: Create bucket 'promo-assets-for-b', NO log entry
    - If A wins or tie: NO bucket creation, log entry with {'status': 'AB_Test_Concluded', 'winner': 'A', 'action': 'No_Change'}
    """
    # Determine winner from overall results - support both with and without 'ab_' prefix
    overall_keys = [
        "overall (total_store_views/total_clicks)",
        "ab_overall (total_store_views/total_clicks)"
    ]
    
    overall_key = None
    for key in overall_keys:
        if key in actual_records:
            overall_key = key
            break
    
    if overall_key is None:
        raise ValueError(f"Cannot determine winner - 'overall' row not found in record.csv. Tried: {overall_keys}")
    
    overall_A = actual_records[overall_key]['A']
    overall_B = actual_records[overall_key]['B']
    
    print(f"\n📊 Overall Results: A={overall_A:.3f}%, B={overall_B:.3f}%")
    
    # Check if promo-assets-for-b bucket exists
    bucket_exists = check_storage_bucket_exists(db, "promo-assets-for-b")
    
    if overall_B > overall_A:
        # B wins - bucket should exist, logging bucket should be clean
        print("🏆 Version B wins!")
        print("Expected: Bucket 'promo-assets-for-b' should exist, no log entry in abtesting_logging")
        
        if not bucket_exists:
            raise ValueError("Task validation failed - Version B won but 'promo-assets-for-b' bucket was not created")
        
        print("Checking that abtesting_logging bucket is clean...")
        if not check_abtesting_logging_bucket_clean(db):
            raise ValueError("Task validation failed - Version B won but abtesting_logging bucket is not clean (should have no log entry)")
        
        print("✅ Task completed correctly for B winner scenario")
        
    else:
        # A wins or tie - bucket should NOT exist, log entry should exist
        if overall_A > overall_B:
            print("🏆 Version A wins!")
        else:
            print("🤝 Results are a tie!")
        
        print("Expected: No bucket creation, log entry in abtesting_logging")
        
        if bucket_exists:
            raise ValueError("Task validation failed - Version A won/tie but 'promo-assets-for-b' bucket was created (should not exist)")
        
        # Check for expected log entry
        expected_log = {'status': 'AB_Test_Concluded', 'winner': 'A', 'action': 'No_Change'}
        print(f"Checking for log entry: {expected_log}")
        
        if not check_abtesting_logging_entry(db, expected_log):
            raise ValueError(f"Task validation failed - Version A won/tie but expected log entry not found in abtesting_logging bucket")
        
        print("✅ Task completed correctly for A winner/tie scenario")

if __name__=="__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=True)
    parser.add_argument("--groundtruth_workspace", required=True)
    parser.add_argument("--res_log_file", required=True)
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()

    # Parse launch_time if provided via command line (join the words back together)
    if args.launch_time:
        launch_time_str = ' '.join(args.launch_time)
        print(f"Launch time from command line: {launch_time_str}")

    # Initialize Google Cloud database
    print("\n📊 Initializing Google Cloud Database for evaluation...")
    gcloud_db_dir = get_gcloud_data_directory(args.agent_workspace)
    print(f"📂 Using Google Cloud Database Directory: {gcloud_db_dir}")
    
    if not Path(gcloud_db_dir).exists():
        print(f"❌ Error: Google Cloud database directory not found: {gcloud_db_dir}")
        print("   Please run preprocessing first to initialize the database.")
        exit(1)
    
    gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)
    
    # Validate record.csv file with comprehensive scenario data
    agent_record_file = os.path.join(args.agent_workspace, "record.csv")
    try:
        print("\nValidating record.csv...")
        
        # Load actual and expected records
        actual_records = read_record_csv(agent_record_file)
        expected_records = load_expected_records(args.groundtruth_workspace)
        
        print(f"Found {len(actual_records)} scenarios in agent's record.csv")
        print(f"Expected {len(expected_records)} scenarios from groundtruth")
        
        # Validate with 0.05% tolerance
        validate_record_data(actual_records, expected_records, tolerance_pct=0.05)
        print("✅ Record validation passed")
        
        # Validate task completion based on A/B test results
        validate_task_completion(gcloud_db, actual_records)
        
    except Exception as e:
        print(f"Record Validation Error: {e}")
        exit(1)

    print(f"\n🎉 A/B testing evaluation passed successfully with comprehensive scenario validation!")
