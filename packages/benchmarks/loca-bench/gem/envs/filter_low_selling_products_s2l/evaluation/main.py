#!/usr/bin/env python3
"""
Low-Selling Product Filtering Task Evaluation Script

Verifies whether the agent correctly filtered low-selling products and sent email notifications
"""

from argparse import ArgumentParser
import sys
import os
import json
from pathlib import Path
from typing import Tuple

# Add project paths
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
sys.path.insert(0, task_dir)



from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase
from mcp_convert.mcps.email.database_utils import EmailDatabase

# Import check_remote from local module
# Use absolute import to avoid relative import issues when running as subprocess
try:
    from .check_remote import check_remote
except ImportError:
    # Fallback for when running from parent directory
    from evaluation.check_remote import check_remote


def get_database_directories(agent_workspace: str) -> Tuple[str, str]:
    """Determine database directories based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    woocommerce_db_dir = str(workspace_parent / "local_db" / "woocommerce")
    email_db_dir = str(workspace_parent / "local_db" / "emails")
    return woocommerce_db_dir, email_db_dir


def read_json(file_path):
    """Read JSON file helper"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Warning: Could not read {file_path}: {e}")
        return {}


def run_complete_evaluation(agent_workspace: str, groundtruth_workspace: str, res_log_file: str) -> Tuple[bool, str]:
    """Run complete evaluation workflow"""

    print("=" * 80)
    print("Low-Selling Products Filter Evaluation (Local Database)")
    print("=" * 80)

    # Determine database directories
    woocommerce_db_dir, email_db_dir = get_database_directories(agent_workspace)

    print(f"\nDatabase Directories:")
    print(f"   WooCommerce: {woocommerce_db_dir}")
    print(f"   Email: {email_db_dir}")

    # Read groundtruth metadata (if exists)
    groundtruth_metadata = None
    if groundtruth_workspace:
        metadata_file = Path(groundtruth_workspace) / "generation_metadata.json"
        if metadata_file.exists():
            try:
                groundtruth_metadata = read_json(str(metadata_file))
                print(f"\nLoaded groundtruth metadata:")
                gen_params = groundtruth_metadata.get('generation_params', {})
                print(f"   - Low-selling products: {gen_params.get('num_low_selling', 'N/A')}")
                print(f"   - Normal-selling products: {gen_params.get('num_normal_selling', 'N/A')}")
                print(f"   - Subscribers: {gen_params.get('num_subscribers', 'N/A')}")
                print(f"   - Total products: {gen_params.get('total_products', 'N/A')}")
                print(f"   - Random seed: {gen_params.get('seed', 'N/A')}")
            except Exception as e:
                print(f"   Warning: Could not load groundtruth metadata: {e}")
    else:
        print(f"\nWarning: No groundtruth workspace provided, using dynamic evaluation only")

    # Check if database directories exist
    if not Path(woocommerce_db_dir).exists():
        error_msg = f"WooCommerce database directory not found: {woocommerce_db_dir}"
        print(error_msg)
        print("   Please run preprocessing first to initialize the database.")
        return False, error_msg

    if not Path(email_db_dir).exists():
        error_msg = f"Email database directory not found: {email_db_dir}"
        print(error_msg)
        print("   Please run preprocessing first to initialize the database.")
        return False, error_msg

    # Initialize databases
    print("\nInitializing Local Databases...")
    try:
        woocommerce_db = WooCommerceDatabase(data_dir=woocommerce_db_dir)
        email_db = EmailDatabase(data_dir=email_db_dir)
        print("Databases initialized successfully")
    except Exception as e:
        error_msg = f"Failed to initialize databases: {e}"
        print(error_msg)
        import traceback
        traceback.print_exc()
        return False, error_msg

    # Set environment variables
    os.environ['WOOCOMMERCE_DATA_DIR'] = woocommerce_db_dir
    os.environ['EMAIL_DATA_DIR'] = email_db_dir

    results = []

    # Load execution log
    res_log = {}
    if res_log_file and os.path.exists(res_log_file):
        res_log = read_json(res_log_file)
        print(f"\nLoaded result log: {res_log_file}")

    # Check remote services (using local databases)
    print("\nSTEP 1: Checking WooCommerce & Email Services (Local DB)...")
    print("=" * 80)
    try:
        # Pass database instances and metadata to check_remote
        remote_pass, remote_msg = check_remote(
            agent_workspace,
            groundtruth_workspace,
            res_log,
            woocommerce_db=woocommerce_db,
            email_db=email_db,
            groundtruth_metadata=groundtruth_metadata
        )
        results.append(("WooCommerce & Email Services", remote_pass, remote_msg))
        print(f"{'PASSED' if remote_pass else 'FAILED'} {remote_msg}")
    except Exception as e:
        error_msg = f"Service check error: {e}"
        results.append(("WooCommerce & Email Services", False, error_msg))
        print(f"FAILED {error_msg}")
        import traceback
        traceback.print_exc()

    # Calculate overall results
    passed_count = sum(1 for _, passed, _ in results if passed)
    total_count = len(results)

    # Summary
    summary = []
    summary.append("\n" + "=" * 80)
    summary.append("EVALUATION SUMMARY")
    summary.append("=" * 80)

    for test_name, passed, message in results:
        status = "PASSED" if passed else "FAILED"
        summary.append(f"{test_name}: {status}")
        if not passed:
            summary.append(f"  Details: {message}")

    overall_pass = passed_count == total_count
    final_message = f"\nOverall: {passed_count}/{total_count} tests passed"

    if overall_pass:
        summary.append(final_message + " - ALL TESTS PASSED!")
        summary.append("\nLow-selling products filter evaluation completed successfully!")
        summary.append("\nSuccessfully filtered low-selling products from WooCommerce")
        summary.append("Successfully sent notification email with product list")
    else:
        summary.append(final_message + " - SOME TESTS FAILED")
        summary.append("\nPlease review the failed tests above")
        summary.append("\nCommon Issues:")
        summary.append("   - Did the agent correctly query WooCommerce for sales data?")
        summary.append("   - Did the agent identify low-selling products correctly?")
        summary.append("   - Did the agent send email notification to the correct recipient?")
        summary.append("   - Does the email contain the correct product information?")

    return overall_pass, "\n".join(summary)


def main(args):
    try:
        if not args.agent_workspace:
            print("Error: --agent_workspace is required")
            sys.exit(1)

        success, message = run_complete_evaluation(
            args.agent_workspace,
            args.groundtruth_workspace,
            args.res_log_file
        )

        print("\n" + "=" * 80)
        print("FINAL EVALUATION RESULT")
        print("=" * 80)
        print(message)

        if success:
            print("\nEVALUATION PASSED")
            sys.exit(0)
        else:
            print("\nEVALUATION FAILED")
            sys.exit(1)

    except Exception as e:
        print(f"Critical evaluation error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    parser = ArgumentParser(description="Low-Selling Products Filter Task Evaluation")
    parser.add_argument("--agent_workspace", required=True, help="Agent workspace directory")
    parser.add_argument("--groundtruth_workspace", required=False, help="Groundtruth workspace directory")
    parser.add_argument("--res_log_file", required=False, help="Result log file path")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    args = parser.parse_args()

    main(args)
