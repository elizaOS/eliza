from argparse import ArgumentParser
import sys
import os
from pathlib import Path

# Keep project root in Python path for safety when executed as a script
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
project_root = os.path.abspath(os.path.join(current_dir, '..', '..', '..'))
sys.path.insert(0, project_root)

from mcp_convert.mcps.snowflake.database_utils import SnowflakeDatabase
from mcp_convert.mcps.email.database_utils import EmailDatabase


from .check_snowflake import main as check_snowflake_main
from .check_emails import main as check_emails_main
# from utils.general.helper import print_color

def print_color(text, color="yellow", end='\n'):
    """
    Print the given text in the specified color.
    
    Args:
    text (str): The text to be printed.
    color (str): The color to use. Supported colors are:
                 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'
    end (str): String appended after the last value, default a newline.
    """
    color_codes = {
        'red': '\033[91m',
        'green': '\033[92m',
        'yellow': '\033[93m',
        'blue': '\033[94m',
        'magenta': '\033[95m',
        'cyan': '\033[96m',
        'white': '\033[97m',
    }
    
    reset_code = '\033[0m'
    
    if color.lower() not in color_codes:
        print(f"Unsupported color: {color}. Using default.", end='')
        print(text, end=end)
    else:
        color_code = color_codes[color.lower()]
        print(f"{color_code}{text}{reset_code}", end=end)

def get_database_directories(agent_workspace: str) -> tuple[str, str]:
    """Determine database directories based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    snowflake_db_dir = str(workspace_parent / "local_db" / "snowflake")
    email_db_dir = str(workspace_parent / "local_db" / "emails")
    return snowflake_db_dir, email_db_dir


def resolve_groundtruth_path(user_dir: str | None) -> str:
    """Resolve groundtruth file path. If not provided, use task default."""
    if user_dir:
        return os.path.join(user_dir, "invoice.jsonl")
    # Default: tasks/weihao/payable-invoice-checker-s2l/groundtruth_workspace/invoice.jsonl
    task_root = os.path.abspath(os.path.join(current_dir, '..'))
    return os.path.join(task_root, 'groundtruth_workspace', 'invoice.jsonl')


if __name__ == "__main__":
    parser = ArgumentParser(description="Payable Invoice Checker Evaluator (Local Database)")
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--groundtruth_workspace", required=False)
    parser.add_argument("--launch_time", required=False)
    parser.add_argument("--res_log_file", required=False)
    parser.add_argument("--subject", "-s", required=False)
    args = parser.parse_args()

    print_color("=" * 80, "cyan")
    print_color("🚀 PAYABLE INVOICE CHECKER EVALUATION - STRICT MODE", "cyan")
    print_color("=" * 80, "cyan")
    print_color("⚠️  STRICT MODE: All payment statuses must be correct, no extra emails allowed", "yellow")
    
    # Resolve groundtruth file
    gt_file = resolve_groundtruth_path(args.groundtruth_workspace)
    print_color(f"\n📋 Groundtruth file: {gt_file}", "blue")
    
    # Initialize local databases if agent_workspace is provided
    snowflake_db = None
    email_db = None
    
    if args.agent_workspace:
        # Determine database directories
        snowflake_db_dir, email_db_dir = get_database_directories(args.agent_workspace)
        
        print_color(f"\n📂 Database Directories:", "cyan")
        print_color(f"   Snowflake: {snowflake_db_dir}", "blue")
        print_color(f"   Email: {email_db_dir}", "blue")
        
        # Check if databases exist
        if not Path(snowflake_db_dir).exists():
            print_color(f"❌ Snowflake database directory not found: {snowflake_db_dir}", "red")
            print_color("   Please run preprocessing first to initialize the database.", "red")
            sys.exit(1)
        
        if not Path(email_db_dir).exists():
            print_color(f"❌ Email database directory not found: {email_db_dir}", "red")
            print_color("   Please run preprocessing first to initialize the database.", "red")
            sys.exit(1)
        
        # Initialize databases
        print_color("\n📊 Initializing Local Databases...", "cyan")
        try:
            snowflake_db = SnowflakeDatabase(data_dir=snowflake_db_dir)
            email_db = EmailDatabase(data_dir=email_db_dir)
            print_color("✅ Databases initialized successfully", "green")
        except Exception as e:
            print_color(f"❌ Failed to initialize databases: {e}", "red")
            import traceback
            traceback.print_exc()
            sys.exit(1)
        
        # Set environment variables
        os.environ['SNOWFLAKE_DATA_DIR'] = snowflake_db_dir
        os.environ['EMAIL_DATA_DIR'] = email_db_dir
        print_color(f"\n✅ Environment variables set", "green")
    else:
        print_color("\n⚠️  No agent_workspace provided, using default MCP server mode", "yellow")

    # Database check
    print_color("\n" + "=" * 80, "cyan")
    print_color("[1/2] Running Snowflake Database Check...", "cyan")
    print_color("=" * 80, "cyan")
    
    try:
        db_success = check_snowflake_main(groundtruth_file=gt_file)
        if db_success:
            print_color("\n✅ Database check: PASS", "green")
        else:
            print_color("\n❌ Database check: FAIL (early exit)", "red")
            sys.exit(1)
    except Exception as e:
        print_color(f"\n❌ Database check error: {e}", "red")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # Email check
    print_color("\n" + "=" * 80, "cyan")
    print_color("[2/2] Running Email Check...", "cyan")
    print_color("=" * 80, "cyan")
    
    try:
        email_success = check_emails_main(groundtruth_file=gt_file)
        if email_success:
            print_color("\n✅ Email check: PASS", "green")
        else:
            print_color("\n❌ Email check: FAIL", "red")
    except Exception as e:
        print_color(f"\n❌ Email check error: {e}", "red")
        import traceback
        traceback.print_exc()
        email_success = False

    # Overall result
    overall = db_success and email_success
    
    print_color("\n" + "=" * 80, "cyan")
    print_color("📊 EVALUATION SUMMARY", "cyan")
    print_color("=" * 80, "cyan")
    
    print_color(f"Snowflake Database: {'✅ PASS' if db_success else '❌ FAIL'}", 
                "green" if db_success else "red")
    print_color(f"Email Notifications: {'✅ PASS' if email_success else '❌ FAIL'}", 
                "green" if email_success else "red")
    
    print_color("\n" + "=" * 80, "cyan")
    if overall:
        print_color("🎉 OVERALL: ALL TESTS PASSED (STRICT MODE)!", "green")
        print_color("=" * 80, "cyan")
        print_color("\n✅ All invoice data correctly inserted into Snowflake", "green")
        print_color("✅ All groundtruth payment statuses are correct", "green")
        print_color("✅ All interference payment data preserved", "green")
        print_color("✅ Each buyer with unpaid invoices received exactly 1 correct email", "green")
        print_color("✅ No extra emails sent to paid buyers or interference addresses", "green")
    else:
        print_color("❌ OVERALL: SOME TESTS FAILED (STRICT MODE)", "red")
        print_color("=" * 80, "cyan")
        print_color("\n📝 Please review the failed checks above", "yellow")
        print_color("Strict mode enforces:", "yellow")
        print_color("  - All payment statuses must match groundtruth", "yellow")
        print_color("  - Exactly one email per buyer with unpaid invoices", "yellow")
        print_color("  - No emails to buyers with only paid invoices", "yellow")
        print_color("  - No emails to interference addresses", "yellow")

    sys.exit(0 if overall else 1)