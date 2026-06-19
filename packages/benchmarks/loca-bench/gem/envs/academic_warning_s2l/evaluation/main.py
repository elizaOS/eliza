from argparse import ArgumentParser
import os
import csv
import json
import ast
import sys
from pathlib import Path
from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase


def get_gcloud_data_directory(agent_workspace: str) -> str:
    """Determine Google Cloud database directory based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
    return gcloud_db_dir


def read_student_data(csv_path: str) -> dict:
    """Read student data including drop ratios"""
    student_data = {}
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "student_id" not in reader.fieldnames:
            raise ValueError(f"File {csv_path} must contain header with 'student_id' column. Found: {reader.fieldnames}")
        
        for row in reader:
            student_id = (row.get("student_id") or "").strip()
            if student_id:
                drop_ratio = float(row.get("drop_ratio", 0))
                student_data[student_id] = {
                    "name": row.get("name", ""),
                    "score": float(row.get("score", 0)),
                    "hist_avg": float(row.get("hist_avg", 0)),
                    "drop_ratio": drop_ratio
                }
    return student_data


def get_students_above_threshold(student_data: dict, threshold: float) -> list:
    """Get students with drop ratio above threshold"""
    return [[student_id, data["name"]] for student_id, data in student_data.items() 
            if data["drop_ratio"] > threshold]


def check_critical_logs_for_students(db: GoogleCloudDatabase, needed_students, unneeded_students) -> bool:
    """Check logs for CRITICAL entry for students above 45% threshold
    
    Supports two methods:
    1. New: Cloud Logging API (db.list_log_entries) - preferred
    2. Legacy: Cloud Storage bucket (db.list_storage_objects) - fallback for backward compatibility
    """
    try:
        critical_logs = []
        method_used = None
        
        # Method 1: Try Cloud Logging API first (new method)
        try:
            log_entries = db.list_log_entries(
                filter_string='logName="exam_log"',
                max_results=1000
            )
            
            if log_entries:
                print(f"Found {len(log_entries)} log entries using Cloud Logging API")
                method_used = "Cloud Logging API"
                
                for entry in log_entries:
                    # Get severity from entry
                    severity = entry.get("severity", "").upper()
                    
                    # Get message from text_payload or json_payload
                    message = None
                    text_payload = entry.get("text_payload")
                    json_payload = entry.get("json_payload")
                    
                    if json_payload and isinstance(json_payload, dict):
                        # For structured logs, check warning_level field
                        warning_level = json_payload.get("warning_level", "").upper()
                        if warning_level == "CRITICAL" or severity == "CRITICAL":
                            message = json_payload.get("message") or json.dumps(json_payload)
                    elif text_payload:
                        if severity == "CRITICAL" or "CRITICAL" in text_payload.upper():
                            message = text_payload
                    
                    if message:
                        critical_logs.append(message)
        except Exception as e:
            print(f"⚠️  Cloud Logging API not available or error: {e}")
        
        # Method 2: Fallback to Storage bucket (legacy method)
        if not critical_logs:
            print("Falling back to legacy Storage bucket method...")
            bucket = db.get_storage_bucket("exam_log")
            if not bucket:
                print("❌ exam_log not found in Cloud Logging or Storage bucket")
                return False
            
            # Get all log objects from the bucket
            log_objects = db.list_storage_objects("exam_log")
            
            if not log_objects:
                print("❌ No log entries found in exam_log bucket")
                return False
            
            print(f"Found {len(log_objects)} log entries in exam_log storage bucket")
            method_used = "Storage Bucket (legacy)"
            
            # Parse log entries and filter CRITICAL ones
            for obj in log_objects:
                content = obj.get("content", "")
                if not content:
                    continue
                
                # Try to parse content - support both JSON and plain text formats
                try:
                    # Try JSON format first
                    log_entry = json.loads(content)
                except (json.JSONDecodeError, ValueError):
                    # Try Python dict format
                    try:
                        log_entry = ast.literal_eval(content)
                    except (ValueError, SyntaxError):
                        # If not structured, treat as plain text
                        # Check if it contains severity marker
                        if "CRITICAL" in content.upper():
                            log_entry = {"severity": "CRITICAL", "message": content}
                        else:
                            continue
                
                # Check severity (support both 'severity' and 'warning_level' fields)
                severity = log_entry.get("severity", log_entry.get("warning_level", "")).upper()
                message = log_entry.get("message", str(log_entry))
                
                if severity == "CRITICAL":
                    critical_logs.append(message)
        
        if not critical_logs:
            print("❌ No CRITICAL log entries found")
            return False
        
        print(f"✓ Method used: {method_used}")
        print(f"Found {len(critical_logs)} CRITICAL log entries")
        
        # Check if each needed student has a CRITICAL log
        used_entry_ids = []
        founds = [False] * len(needed_students)
        
        for idx, (student_id, student_name) in enumerate(needed_students):
            for eid, message in enumerate(critical_logs):
                if eid in used_entry_ids:
                    continue
                
                # Check if log mentions the student (by ID or name)
                if str(student_id) in message and str(student_name) in message:
                    print(f"✅ Found CRITICAL log for {student_name} ({student_id}): {message[:100]}...")
                    founds[idx] = True
                    used_entry_ids.append(eid)
                    break
        
        # Verify all needed students have logs
        if not all(founds):
            for idx, found in enumerate(founds):
                if not found:
                    student_id, student_name = needed_students[idx]
                    print(f"❌ Missing CRITICAL log for {student_name} ({student_id})")
            return False
        
        # Check that unneeded students don't have CRITICAL logs
        for message in critical_logs:
            for student_id, student_name in unneeded_students:
                if str(student_id) in message or str(student_name) in message:
                    print(f"❌ Found unexpected CRITICAL log for {student_name} ({student_id}): {message[:100]}...")
                    return False
        
        return True
        
    except Exception as e:
        print(f"❌ Error checking exam_log bucket: {e}")
        import traceback
        traceback.print_exc()
        return False


def get_all_students(files_dir: Path) -> list:
    """Get all students from the first historical exam file
    
    Args:
        files_dir: Path to the files directory containing exam CSV files
        
    Returns:
        List of [student_id, name] pairs
    """
    try:
        # Find the first scores CSV file
        import glob
        csv_files = sorted(glob.glob(str(files_dir / "scores_*.csv")))
        
        if not csv_files:
            print(f"⚠️  Warning: No scores CSV files found in {files_dir}")
            return []
        
        # Use the first file to get all students
        first_file = csv_files[0]
        students = []
        
        with open(first_file, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if "student_id" in row and "name" in row:
                    students.append([row["student_id"], row["name"]])
        
        return students
        
    except Exception as e:
        print(f"⚠️  Warning: Error reading student list: {e}")
        return []


if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=True)
    parser.add_argument("--groundtruth_workspace", required=True)
    parser.add_argument("--res_log_file", required=True)
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()

    print("=" * 60)
    print("Academic Warning Evaluation - Updated Requirements")
    print("- 100% accuracy for student selection in bad_student.csv")
    print("- Check for all students critical log")
    print("=" * 60)

    # Parse launch_time if provided
    if args.launch_time:
        launch_time_str = ' '.join(args.launch_time) if isinstance(args.launch_time, list) else args.launch_time
        print(f"Launch time: {launch_time_str}")

    # Initialize Google Cloud database
    print("\n📊 Initializing Google Cloud Database for evaluation...")
    gcloud_db_dir = get_gcloud_data_directory(args.agent_workspace)
    print(f"📂 Using Google Cloud Database Directory: {gcloud_db_dir}")
    
    if not Path(gcloud_db_dir).exists():
        print(f"❌ Error: Google Cloud database directory not found: {gcloud_db_dir}")
        print("   Please run preprocessing first to initialize the database.")
        sys.exit(1)
    
    gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)
    
    # Determine task root and files directory
    task_root = Path(__file__).parent.parent
    files_dir = task_root / "files"

    agent_needed_file = os.path.join(args.agent_workspace, "bad_student.csv")
    agent_groundtruth_file = os.path.join(args.groundtruth_workspace, "expected_alerts.csv")

    try:
        # Validate file existence
        if not os.path.isfile(agent_needed_file):
            raise FileNotFoundError(f"Missing agent output file: {agent_needed_file}")
        if not os.path.isfile(agent_groundtruth_file):
            raise FileNotFoundError(f"Missing groundtruth file: {agent_groundtruth_file}")

        # Read ground truth data
        print("\n1. Reading ground truth data...")
        gt_data = read_student_data(agent_groundtruth_file)
        print(f"Ground truth contains {len(gt_data)} students")

        # Read agent output data  
        print("\n2. Reading agent output data...")
        try:
            agent_data = read_student_data(agent_needed_file)
            print(f"Agent output contains {len(agent_data)} students")
        except Exception as e:
            print(f"❌ Error reading agent output: {e}")
            # Fallback: just read student IDs
            with open(agent_needed_file, "r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f)
                agent_ids = [row.get("student_id", "").strip() for row in reader if row.get("student_id", "").strip()]
            agent_data = {sid: {"drop_ratio": 0.3} for sid in agent_ids}  # Assume >25% for validation

        # Determine expected students for different thresholds
        print("\n3. Analyzing thresholds...")
        gt_25_percent = get_students_above_threshold(gt_data, 0.25)
        gt_45_percent = get_students_above_threshold(gt_data, 0.45)
        all_students = get_all_students(files_dir)
        all_below_45_percent = [x for x in all_students if x not in gt_45_percent]
        
        print(f"Students with >25% drop (should be in bad_student.csv): {len(gt_25_percent)}")
        print(f"Students with >45% drop (should have CRITICAL logs): {len(gt_45_percent)}")

        # Validate bad_student.csv with 100% accuracy requirement
        print("\n4. Validating bad_student.csv with 100% accuracy...")
        agent_ids = set(agent_data.keys())
        gt_25_set = set([item[0] for item in gt_25_percent])

        # Calculate accuracy: how many selected students are correct
        # Check for exact match - both sets must be identical
        is_exact_match = agent_ids == gt_25_set
        accuracy = 1.0 if is_exact_match else 0.0
        
        print(f"Agent selected {len(agent_ids)} students")
        print(f"Ground truth has {len(gt_25_set)} students with >25% drop")
        print(f"Exact match: {is_exact_match}")
        print(f"Accuracy: {accuracy:.2%}")

        if not is_exact_match:
            missing_in_agent = sorted(gt_25_set - agent_ids)
            extra_in_agent = sorted(agent_ids - gt_25_set)
            print(f"❌ Not an exact match - accuracy is 0%")
            if missing_in_agent:
                print(f"Missing students (in GT but not in agent): {missing_in_agent[:5]}{'...' if len(missing_in_agent) > 5 else ''}")
            if extra_in_agent:
                print(f"Incorrect students (in agent but not in GT): {extra_in_agent[:5]}{'...' if len(extra_in_agent) > 5 else ''}")
            raise ValueError(f"bad_student.csv does not exactly match ground truth (accuracy: {accuracy:.2%})")

        print(f"✅ bad_student.csv accuracy {accuracy:.2%} meets 100% threshold")

        # Check local database logs for students above 45% threshold
        print("\n5. Checking local database logs for students with >45% drop...")
        logs_valid = check_critical_logs_for_students(gcloud_db, gt_45_percent, all_below_45_percent)
        
        if not logs_valid:
            print("❌ Critical log validation failed")
            sys.exit(1)

        print("\n" + "=" * 60)
        print("🎉 EVALUATION PASSED SUCCESSFULLY!")
        print(f"✅ Verified {accuracy:.1%} accuracy in bad_student.csv (≥100% required)")
        print(f"✅ Verified all students CRITICAL log exists")
        print("=" * 60)

    except Exception as e:
        print(f"\n❌ EVALUATION FAILED: {e}")
        sys.exit(1)
