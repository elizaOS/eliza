from argparse import ArgumentParser
import sys
import os
from pathlib import Path


if __name__=="__main__":
    parser = ArgumentParser(description="Course Assistant Evaluation Script")
    parser.add_argument("--agent_workspace", required=False, help="Agent workspace path")
    parser.add_argument("--groundtruth_workspace", required=False, help="Groundtruth workspace path")
    parser.add_argument("--res_log_file", required=False, help="Result log file path")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    parser.add_argument('--subject', '-s', default='nlp-course-emergency', help='Email subject keyword')
    args = parser.parse_args()

    print("=" * 60)
    print("🔍 Course Assistant Task Evaluation")
    print("=" * 60)

    # Check if check_local.py exists
    current_dir = Path(__file__).parent
    check_local_path = current_dir / "check_local.py"

    if not check_local_path.exists():
        print("\n❌ Error: check_local.py does not exist")
        print("💡 Please run preprocessing script to generate configuration first:")
        print("   python3 preprocess/main.py --agent_workspace /path/to/workspace")
        exit(1)

    # Dynamically import check_local
    try:
        from .check_local import main as check_local_main
        print("✅ Using dynamically generated check_local.py configuration")
    except ImportError as e:
        print(f"❌ Error: Cannot import check_local: {e}")
        print("💡 Please ensure check_local.py format is correct")
        exit(1)

    # Set EMAIL_DATA_DIR environment variable
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        email_db_dir = str(workspace_parent / "local_db" / "emails")
        os.environ['EMAIL_DATA_DIR'] = email_db_dir
        print(f"📂 Agent workspace: {args.agent_workspace}")
        print(f"📂 Email database directory: {email_db_dir}")

    # Display check information
    print(f"📧 Checking email subject: {args.subject}")
    print("=" * 60)

    # Run email check
    try:
        success = check_local_main()
    except Exception as e:
        print(f"\n❌ Exception occurred during execution: {e}")
        import traceback
        traceback.print_exc()
        success = False

    print("\n" + "=" * 60)
    if success:
        print("🎉 Evaluation successful! All students received correct reminder emails")
        print("=" * 60)
        print("✅ Email subject correct: nlp-course-emergency")
        print("✅ Email content includes student name and student ID")
        print("✅ No extra or incorrect emails")
    else:
        print("💥 Evaluation failed! Please check error messages above")
        print("=" * 60)
        print("📝 Common issues:")
        print("   • Did the agent correctly identify students who haven't submitted?")
        print("   • Is the email subject 'nlp-course-emergency'?")
        print("   • Does the email content include student's name and student ID?")
        print("   • Was the email sent to the correct student mailbox?")

    exit(0 if success else 1)