from argparse import ArgumentParser
import sys
import os
from pathlib import Path
from datetime import datetime

# Add current directory to sys.path for imports when running as standalone script
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from mcp_convert.mcps.email.database_utils import EmailDatabase
from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase
from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase

from evaluate_updated_stock_alert import StockAlertEvaluator  # type: ignore


def get_database_directories(agent_workspace: str) -> tuple[str, str, str]:
    """Determine database directories based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    woocommerce_db_dir = str(workspace_parent / "local_db" / "woocommerce")
    email_db_dir = str(workspace_parent / "local_db" / "emails")
    google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
    return woocommerce_db_dir, email_db_dir, google_sheet_db_dir

def run_complete_evaluation(agent_workspace: str) -> tuple[bool, str]:
    """Run complete evaluation workflow for stock alert task using local databases"""

    print("🚀 Starting Stock Alert System Evaluation (Local Database)")
    print("=" * 80)

    try:
        # Determine database directories
        woocommerce_db_dir, email_db_dir, google_sheet_db_dir = get_database_directories(agent_workspace)
        
        print(f"\n📂 Database Directories:")
        print(f"   WooCommerce: {woocommerce_db_dir}")
        print(f"   Email: {email_db_dir}")
        print(f"   Google Sheets: {google_sheet_db_dir}")
        
        # Check if databases exist
        if not Path(woocommerce_db_dir).exists():
            error_msg = f"❌ WooCommerce database directory not found: {woocommerce_db_dir}"
            print(error_msg)
            print("   Please run preprocessing first to initialize the database.")
            return False, error_msg
        
        if not Path(email_db_dir).exists():
            error_msg = f"❌ Email database directory not found: {email_db_dir}"
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
            email_db = EmailDatabase(data_dir=email_db_dir)
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
        os.environ['EMAIL_DATA_DIR'] = email_db_dir
        os.environ['GOOGLE_SHEET_DATA_DIR'] = google_sheet_db_dir
        
        # Initialize evaluator with local databases
        evaluator = StockAlertEvaluator(
            agent_workspace, 
            email_db=email_db, 
            google_sheet_db=google_sheet_db,
            woocommerce_db=woocommerce_db
        )

        # Run evaluation
        results = evaluator.run_evaluation()

        # Extract results
        overall = results.get("overall", {})
        sheets_result = results.get("google_sheets_update", {})
        email_result = results.get("email_notifications", {})

        # Build summary
        summary = []
        summary.append("\n" + "=" * 80)
        summary.append("EVALUATION SUMMARY")
        summary.append("=" * 80)

        # Component results
        components = [
            ("Google Sheets Update", sheets_result.get("passed", False), sheets_result.get("message", "")),
            ("Email Notifications", email_result.get("passed", False), email_result.get("message", ""))
        ]

        for name, passed, message in components:
            status = "✅ PASSED" if passed else "❌ FAILED"
            summary.append(f"{name}: {status}")
            summary.append(f"  {message}")

        # Overall result
        passed_count = overall.get("tests_passed", 0)
        total_count = overall.get("total_tests", 2)
        success_rate = (passed_count / total_count) * 100 if total_count > 0 else 0
        overall_pass = overall.get("passed", False)

        final_message = f"\nOverall: {passed_count}/{total_count} tests passed ({success_rate:.1f}%)"

        if overall_pass:
            summary.append(final_message + " - ✅ ALL TESTS PASSED!")
            summary.append("\n🎉 Stock alert system evaluation completed successfully!")
            summary.append("\nThe system correctly:")
            summary.append("  ✓ Added ALL low-stock products to Google Sheets")
            summary.append("  ✓ Did NOT add any normal-stock products (strict filtering)")
            summary.append("  ✓ Sent email alerts to purchasing manager for each low-stock product")
            summary.append("  ✓ Used correct email template format")
        else:
            summary.append(final_message + " - ❌ SOME TESTS FAILED")
            summary.append("\n❌ Please review the failed components above")

            # Add failure hints
            failed_components = [name for name, passed, _ in components if not passed]
            if failed_components:
                summary.append(f"\nFailed components: {', '.join(failed_components)}")
                summary.append("\nRequired fixes:")
                if "Google Sheets Update" in failed_components:
                    summary.append("  - Ensure ALL low-stock products are added to sheet")
                    summary.append("  - Sheet should ONLY contain low-stock products (stock_quantity < stock_threshold)")
                    summary.append("  - Do NOT add normal-stock products to the sheet")
                    summary.append("  - Verify products data matches WooCommerce (stock quantity, threshold, SKU)")
                    summary.append("  - Check that all required columns are present and properly filled")
                if "Email Notifications" in failed_components:
                    summary.append("  - Send emails for each low-stock product to laura_thompson@mcp.com")
                    summary.append("  - Each email should contain the product SKU and follow the template format")
                    summary.append("  - Email count should match the number of low-stock products")

        return overall_pass, "\n".join(summary)

    except Exception as e:
        error_msg = f"❌ Critical evaluation error: {str(e)}"
        print(error_msg)
        import traceback
        traceback.print_exc()
        return False, error_msg

if __name__ == "__main__":
    parser = ArgumentParser(description="Evaluate Stock Alert Monitoring System")
    parser.add_argument("--agent_workspace", required=False, default=".",
                       help="Path to agent's workspace with implementation")
    parser.add_argument("--groundtruth_workspace", required=False,
                       help="Path to ground truth workspace (not used)")
    parser.add_argument("--res_log_file", required=False,
                       help="Path to result log file (optional)")
    parser.add_argument("--launch_time", required=False,
                       help="Launch time (optional)")
    args = parser.parse_args()
    
    try:
        # Run evaluation
        success, message = run_complete_evaluation(args.agent_workspace)
        
        # Print final results
        print("\n" + "="*80)
        print("FINAL EVALUATION RESULT")
        print("="*80)
        print(message)
        
        # Write to log file if specified
        if args.res_log_file:
            try:
                # Write evaluation results to a separate file, not the trajectory file
                eval_temp_file = os.path.join(os.path.dirname(args.res_log_file), "eval_temp.txt")
                with open(eval_temp_file, 'w', encoding='utf-8') as f:
                    f.write(f"Stock Alert Evaluation Results\n")
                    f.write(f"{'='*80}\n")
                    f.write(f"Agent Workspace: {args.agent_workspace}\n")
                    if args.launch_time:
                        f.write(f"Launch Time: {args.launch_time}\n")
                    f.write(f"{'='*80}\n")
                    f.write(message)
                    f.write(f"\n{'='*80}\n")
                    f.write(f"Result: {'PASSED' if success else 'FAILED'}\n")
            except Exception as e:
                print(f"Warning: Could not write to log file: {e}")
        
        # Exit with appropriate code
        if success:
            print("\n✅ EVALUATION PASSED")
            sys.exit(0)
        else:
            print("\n❌ EVALUATION FAILED")
            sys.exit(1)
            
    except Exception as e:
        print(f"❌ Critical evaluation error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)