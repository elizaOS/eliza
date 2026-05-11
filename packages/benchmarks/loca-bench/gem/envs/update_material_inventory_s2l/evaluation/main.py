from argparse import ArgumentParser
import sys
import os
import json
import logging
from pathlib import Path

# Add project paths
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
sys.path.insert(0, task_dir)
sys.path.insert(0, current_dir)

from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase
from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase

# Use regular imports since current_dir is already in sys.path
from check_sheets import evaluate_sheets_integration  # type: ignore
from check_woocommerce import evaluate_woocommerce_sync  # type: ignore

def setup_logging():
    """Setup logging"""
    logging.basicConfig(level=logging.INFO)
    return logging.getLogger(__name__)

def get_database_directories(agent_workspace: str) -> tuple[str, str]:
    """Determine database directories based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    woocommerce_db_dir = str(workspace_parent / "local_db" / "woocommerce")
    google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
    return woocommerce_db_dir, google_sheet_db_dir

def read_json(file_path: str) -> dict:
    """Read JSON file helper"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"⚠️  Warning: Could not read {file_path}: {e}")
        return {}

def run_complete_evaluation(agent_workspace: str, groundtruth_workspace: str, res_log_file: str) -> tuple[bool, str]:
    """Run complete evaluation workflow using local databases"""
    
    print("=" * 80)
    print("🚀 Material Inventory Management Evaluation (Local Database)")
    print("=" * 80)
    
    logger = setup_logging()
    
    # Read groundtruth metadata if available
    groundtruth_metadata = None
    if groundtruth_workspace:
        metadata_file = Path(groundtruth_workspace) / "generation_metadata.json"
        if metadata_file.exists():
            try:
                groundtruth_metadata = read_json(str(metadata_file))
                print(f"\n📋 Task Configuration (from preprocessing):")
                gen_params = groundtruth_metadata.get('generation_params', {})
                gen_data = groundtruth_metadata.get('generated_data', {})
                
                print(f"   Difficulty: {gen_params.get('difficulty', 'N/A').upper()}")
                print(f"   Products: {gen_data.get('products_count', gen_params.get('num_products', 'N/A'))}")
                print(f"   Materials: {gen_data.get('materials_count', gen_params.get('num_materials', 'N/A'))}")
                print(f"   Materials per product (avg): {gen_params.get('materials_per_product', 'N/A')}")
                print(f"   BOM entries: {gen_data.get('bom_entries_count', 'N/A')}")
                print(f"   Test orders: {gen_params.get('num_orders', 'N/A')}")
                print(f"   Random seed: {gen_params.get('seed', 'N/A')}")
                
                # Show product details
                if 'products' in gen_data:
                    print(f"\n   📦 Products generated:")
                    for product in gen_data['products']:
                        print(f"      • {product['sku']}: {product['name']}")
                
            except Exception as e:
                print(f"   ⚠️  Could not load groundtruth metadata: {e}")
    else:
        print(f"\n⚠️  No groundtruth workspace provided")
    
    # Determine database directories
    woocommerce_db_dir, google_sheet_db_dir = get_database_directories(agent_workspace)
    
    print(f"\n📂 Database Directories:")
    print(f"   WooCommerce: {woocommerce_db_dir}")
    print(f"   Google Sheets: {google_sheet_db_dir}")
    
    # Check if databases exist
    if not Path(woocommerce_db_dir).exists():
        error_msg = f"❌ WooCommerce database directory not found: {woocommerce_db_dir}"
        print(error_msg)
        print("   Please run preprocessing first to initialize the database.")
        return False, error_msg
    
    if not Path(google_sheet_db_dir).exists():
        error_msg = f"❌ Google Sheets database directory not found: {google_sheet_db_dir}"
        print(error_msg)
        print("   Please run preprocessing first to initialize the database.")
        return False, error_msg
    
    # Initialize databases
    print("\n📊 Initializing Local Databases...")
    try:
        woocommerce_db = WooCommerceDatabase(data_dir=woocommerce_db_dir)
        google_sheet_db = GoogleSheetDatabase(data_dir=google_sheet_db_dir)
        print("✅ Databases initialized successfully")
    except Exception as e:
        error_msg = f"❌ Failed to initialize databases: {e}"
        print(error_msg)
        import traceback
        traceback.print_exc()
        return False, error_msg
    
    # Set environment variables
    os.environ['WOOCOMMERCE_DATA_DIR'] = woocommerce_db_dir
    os.environ['GOOGLE_SHEET_DATA_DIR'] = google_sheet_db_dir
    
    results = []
    
    # Determine groundtruth_workspace path
    groundtruth_ws = groundtruth_workspace if groundtruth_workspace else None
    
    # Step 1: Check Google Sheets integration
    print("\n📊 STEP 1: Checking Google Sheets Integration...")
    print("=" * 80)
    try:
        sheets_result = evaluate_sheets_integration(agent_workspace, google_sheet_db, groundtruth_ws)
        sheets_pass = sheets_result['status'] != 'failed'
        sheets_msg = f"Sheets integration check: {sheets_result.get('score', 0):.2f}"
        results.append(("Google Sheets", sheets_pass, sheets_msg))
        print(f"{'✅' if sheets_pass else '❌'} {sheets_msg}")
        
        # Print detailed issues if failed
        if not sheets_pass and sheets_result.get('issues'):
            print(f"\n❌ Issues found:")
            for issue in sheets_result['issues']:
                print(f"   - {issue}")
        
        # Print check details if available
        if sheets_result.get('checks'):
            print(f"\nCheck details: {sheets_result['checks']}")
            
    except Exception as e:
        results.append(("Google Sheets", False, str(e)))
        print(f"❌ Google Sheets error: {e}")
        import traceback
        traceback.print_exc()

    # Step 2: Check WooCommerce sync
    print("\n🛒 STEP 2: Checking WooCommerce Sync...")
    print("=" * 80)
    try:
        wc_result = evaluate_woocommerce_sync(agent_workspace, woocommerce_db, groundtruth_ws)
        wc_pass = wc_result['status'] != 'failed'
        wc_msg = f"WooCommerce sync check: {wc_result.get('score', 0):.2f}"
        results.append(("WooCommerce Sync", wc_pass, wc_msg))
        print(f"{'✅' if wc_pass else '❌'} {wc_msg}")
        
        # Print detailed issues if failed
        if not wc_pass and wc_result.get('issues'):
            print(f"\n❌ Issues found:")
            for issue in wc_result['issues']:
                print(f"   - {issue}")
        
        # Print check details if available
        if wc_result.get('checks'):
            print(f"\nCheck details: {wc_result['checks']}")
            
    except Exception as e:
        results.append(("WooCommerce Sync", False, str(e)))
        print(f"❌ WooCommerce sync error: {e}")
        import traceback
        traceback.print_exc()

    # Calculate overall results - ALL tests must pass (strict evaluation)
    passed_count = sum(1 for _, passed, _ in results if passed)
    total_count = len(results)
    
    # Summary
    summary = []
    summary.append("\\n" + "=" * 80)
    summary.append("EVALUATION SUMMARY")
    summary.append("=" * 80)

    for test_name, passed, message in results:
        status = "✅ PASSED" if passed else "❌ FAILED"
        summary.append(f"{test_name}: {status}")
        if not passed:
            summary.append(f"  Details: {message}")

    summary.append(f"\\nTests Passed: {passed_count}/{total_count}")

    # Determine final status - ALL tests must pass (strict evaluation)
    overall_pass = passed_count == total_count and total_count > 0

    # Add task configuration to summary
    if groundtruth_metadata:
        gen_params = groundtruth_metadata.get('generation_params', {})
        gen_data = groundtruth_metadata.get('generated_data', {})
        summary.append(f"\\n📊 Task Configuration:")
        summary.append(f"   Difficulty: {gen_params.get('difficulty', 'N/A').upper()}")
        summary.append(f"   Products: {gen_data.get('products_count', 'N/A')}")
        summary.append(f"   Materials: {gen_data.get('materials_count', 'N/A')}")
        summary.append(f"   BOM entries: {gen_data.get('bom_entries_count', 'N/A')}")
    
    if overall_pass:
        summary.append("\\n🎉 EVALUATION PASSED - Material inventory management system working correctly!")
        summary.append("\\n✅ Successfully read BOM and inventory data from Google Sheets")
        summary.append("✅ Successfully calculated max producible quantities")
        summary.append("✅ Successfully updated WooCommerce product stock")
        summary.append("✅ All inventory values match expected results")
    else:
        summary.append("\\n❌ EVALUATION FAILED - All core functions must pass")
        summary.append("Requirements: Perfect match with expected results for all components")
        summary.append("\\n📝 Common Issues:")
        summary.append("   • Did the agent correctly read BOM from Google Sheets?")
        summary.append("   • Did the agent correctly read material inventory from Google Sheets?")
        summary.append("   • Did the agent calculate max producible quantities correctly?")
        summary.append("   • Did the agent update WooCommerce product stock quantities?")
        summary.append("   • Do all inventory values match the expected final state?")

    return overall_pass, "\\n".join(summary)

if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False, default=".")
    parser.add_argument("--groundtruth_workspace", required=False)
    parser.add_argument("--res_log_file", required=False)
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()
    
    try:
        success, message = run_complete_evaluation(
            args.agent_workspace, 
            args.groundtruth_workspace or "", 
            args.res_log_file
        )
        
        print("\\n" + "="*80)
        print("FINAL EVALUATION RESULT")
        print("="*80)
        print(message)
        
        if success:
            print("\\n✅ EVALUATION PASSED")
            sys.exit(0)
        else:
            print("\\n❌ EVALUATION FAILED")
            sys.exit(1)
            
    except Exception as e:
        print(f"❌ Critical evaluation error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)