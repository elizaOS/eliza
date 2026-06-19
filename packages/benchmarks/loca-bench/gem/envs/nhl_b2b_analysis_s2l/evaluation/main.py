#!/usr/bin/env python3
"""
Evaluation script for NHL B2B Analysis task (Local Database Version).
This script evaluates the agent's analysis results using local Google Sheets database.
"""

import os
import sys
import argparse
import json

# Add project root directory to Python path
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
sys.path.insert(0, project_root)

# Import modules directly to avoid hyphen issues
import importlib.util
from pathlib import Path

from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase


def read_json(file_path: str) -> dict:
    """Read JSON file helper"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"⚠️  Warning: Could not read {file_path}: {e}")
        return {}


# Dynamically import check modules
def load_check_module(module_name):
    module_path = Path(__file__).parent / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module {module_name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

check_local_module = load_check_module("check_local")
check_sheet_comparison_module = load_check_module("check_sheet_comparison")  # Use Sheet comparison
check_sheet_direct_module = load_check_module("check_sheet_direct")  # Direct Sheet check

check_local = check_local_module.check_local
check_sheet_comparison = check_sheet_comparison_module.check_sheet_comparison
check_google_sheet_direct = check_sheet_direct_module.check_google_sheet_direct


def get_database_directory(agent_workspace: str) -> str:
    """Determine database directory based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
    return google_sheet_db_dir


def main():
    """Main function, supports command line execution"""
    parser = argparse.ArgumentParser(description='Evaluate NHL back-to-back analysis task (Local Database)')
    parser.add_argument('--res_log_file', required=False, help='Path to result log file')
    parser.add_argument('--agent_workspace', required=True, help='Path to agent workspace')
    parser.add_argument('--groundtruth_workspace', required=True, help='Path to groundtruth workspace')
    parser.add_argument("--launch_time", required=False, help="Launch time")
    
    args = parser.parse_args()
    
    print("="*80)
    print("🏒 NHL B2B ANALYSIS TASK EVALUATION (Local Database)")
    print("="*80)
    
    # Read groundtruth metadata if available
    groundtruth_metadata = None
    task_root = Path(__file__).parent.parent
    
    if args.groundtruth_workspace:
        metadata_file = Path(args.groundtruth_workspace) / "generation_metadata.json"
        if metadata_file.exists():
            try:
                groundtruth_metadata = read_json(str(metadata_file))
                print(f"\n📋 Task Configuration (from preprocessing):")
                gen_params = groundtruth_metadata.get('generation_params', {})
                
                difficulty = gen_params.get('difficulty', 'N/A')
                num_games = gen_params.get('num_games', 'N/A')
                num_teams = gen_params.get('num_teams', 'N/A')
                start_date = gen_params.get('start_date', 'N/A')
                seed = gen_params.get('seed', 'N/A')
                
                print(f"   Difficulty: {difficulty.upper() if isinstance(difficulty, str) else difficulty}")
                print(f"   Games: {num_games}")
                print(f"   Teams: {num_teams}")
                print(f"   Start date: {start_date}")
                print(f"   Random seed: {seed}")
                
            except Exception as e:
                print(f"   ⚠️  Could not load groundtruth metadata: {e}")
    else:
        # Try to load from task preprocess directory
        preprocess_metadata = task_root / "preprocess" / "generation_metadata.json"
        if preprocess_metadata.exists():
            try:
                groundtruth_metadata = read_json(str(preprocess_metadata))
                print(f"\n📋 Task Configuration (from preprocessing):")
                gen_params = groundtruth_metadata.get('generation_params', {})
                
                difficulty = gen_params.get('difficulty', 'N/A')
                num_games = gen_params.get('num_games', 'N/A')
                num_teams = gen_params.get('num_teams', 'N/A')
                
                print(f"   Difficulty: {difficulty.upper() if isinstance(difficulty, str) else difficulty}")
                print(f"   Games: {num_games}")
                print(f"   Teams: {num_teams}")
                
            except Exception as e:
                print(f"   ⚠️  Could not load preprocessing metadata: {e}")
    
    # Determine database directory
    google_sheet_db_dir = get_database_directory(args.agent_workspace)
    
    print(f"\n📂 Database Directory:")
    print(f"   Google Sheets: {google_sheet_db_dir}")
    
    # Check if database exists
    if not Path(google_sheet_db_dir).exists():
        error_msg = f"❌ Google Sheets database directory not found: {google_sheet_db_dir}"
        print(error_msg)
        print("   Please run preprocessing first to initialize the database.")
        exit(1)
    
    # Initialize database
    print("\n📊 Initializing Local Database...")
    try:
        google_sheet_db = GoogleSheetDatabase(data_dir=google_sheet_db_dir)
        print("✅ Database initialized successfully")
    except Exception as e:
        error_msg = f"❌ Failed to initialize database: {e}"
        print(error_msg)
        import traceback
        traceback.print_exc()
        exit(1)
    
    # Set environment variable
    os.environ['GOOGLE_SHEET_DATA_DIR'] = google_sheet_db_dir
    
    print("\n" + "="*80)
    print("STEP 1: Check Local File Generation")
    print("="*80)
    
    # Check local file generation (primary check)
    try:
        local_pass, local_msg = check_local(args.agent_workspace, args.groundtruth_workspace)
        if not local_pass:
            print(f"❌ Local check failed: {local_msg}")
            exit(1)
        else:
            print(f"✅ Local check passed: {local_msg}")
    except Exception as e:
        print(f"❌ Local check error: {e}")
        import traceback
        traceback.print_exc()
        exit(1)
    
    print("\n" + "="*80)
    print("STEP 2: Check Google Sheet Direct Verification")
    print("="*80)
    
    # Check Google Sheet direct verification (priority check - no content download)
    sheet_direct_passed = False
    try:
        sheet_direct_pass, sheet_direct_msg = check_google_sheet_direct(args.agent_workspace, args.groundtruth_workspace)
        if sheet_direct_pass:
            print(f"✅ Sheet direct check passed: {sheet_direct_msg}")
            sheet_direct_passed = True
        else:
            print(f"⚠️  Sheet direct check failed: {sheet_direct_msg}")
            # Direct check failed, try content comparison check
            print("\n   Trying content comparison check as fallback...")
    except Exception as e:
        print(f"⚠️  Sheet direct check error: {e}")
        print("\n   Direct check error, trying content comparison check as fallback...")
        import traceback
        traceback.print_exc()
    
    # IMPORTANT: Always run comparison check to verify numeric values
    # Direct check only verifies structure, not content accuracy
    print("\n" + "="*80)
    print("STEP 3: Check Google Sheet Content Comparison")
    print("="*80)
    
    # Check Google Sheet comparison (REQUIRED - compare with standard answer)
    try:
        sheet_comparison_pass, sheet_comparison_msg = check_sheet_comparison(args.agent_workspace, args.groundtruth_workspace)
        if not sheet_comparison_pass:
            print(f"❌ Sheet comparison failed: {sheet_comparison_msg}")
            print("\n⚠️  Note: Even though direct check passed, numeric values don't match standard answer!")
            exit(1)
        else:
            print(f"✅ Sheet comparison passed: {sheet_comparison_msg}")
    except Exception as e:
        print(f"❌ Sheet comparison error: {e}")
        import traceback
        traceback.print_exc()
        exit(1)
    
    # Final summary
    print("\n" + "="*80)
    print("EVALUATION SUMMARY")
    print("="*80)
    print("✅ All checks passed!")
    print("\nCompleted checks:")
    print("  ✓ Local file generation")
    if sheet_direct_passed:
        print("  ✓ Google Sheet direct verification (structure)")
    else:
        print("  ⚠️  Google Sheet direct verification (failed/error)")
    print("  ✓ Google Sheet content comparison (numeric values)")
    
    # Display task configuration if available
    if groundtruth_metadata:
        gen_params = groundtruth_metadata.get('generation_params', {})
        print(f"\n📊 Task Configuration:")
        
        difficulty = gen_params.get('difficulty', 'N/A')
        if difficulty != 'N/A':
            print(f"   Difficulty: {difficulty.upper() if isinstance(difficulty, str) else difficulty}")
        
        num_games = gen_params.get('num_games')
        if num_games:
            print(f"   Games analyzed: {num_games}")
        
        num_teams = gen_params.get('num_teams')
        if num_teams:
            print(f"   Teams involved: {num_teams}")
        
        start_date = gen_params.get('start_date')
        if start_date:
            print(f"   Season start: {start_date}")
    
    print(f"\n🎉 Pass all tests! NHL back-to-back analysis task evaluation completed")
    
    # Write results to log file if specified
    if args.res_log_file:
        try:
            eval_temp_file = os.path.join(os.path.dirname(args.res_log_file), "eval_temp.txt")
            with open(eval_temp_file, 'w', encoding='utf-8') as f:
                f.write(f"NHL B2B Analysis Evaluation Results\n")
                f.write(f"{'='*80}\n")
                f.write(f"Agent Workspace: {args.agent_workspace}\n")
                f.write(f"Groundtruth Workspace: {args.groundtruth_workspace}\n")
                if args.launch_time:
                    f.write(f"Launch Time: {args.launch_time}\n")
                f.write(f"{'='*80}\n")
                f.write(f"Local Check: PASSED\n")
                if sheet_direct_passed:
                    f.write(f"Sheet Direct Check: PASSED\n")
                else:
                    f.write(f"Sheet Direct Check: FAILED/ERROR\n")
                f.write(f"Sheet Comparison Check (Numeric Values): PASSED\n")
                f.write(f"{'='*80}\n")
                f.write(f"Result: PASSED\n")
        except Exception as e:
            print(f"⚠️  Warning: Could not write to log file: {e}")


if __name__ == "__main__":
    main()
