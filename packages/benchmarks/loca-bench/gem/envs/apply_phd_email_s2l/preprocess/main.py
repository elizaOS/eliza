import sys
import os
import tarfile
import json
from argparse import ArgumentParser
from pathlib import Path
from typing import List, Dict

# Add current directory to path for importing local modules
current_dir = Path(__file__).parent
sys.path.insert(0, str(current_dir))

# Add mcp_convert path to import EmailDatabase

from mcp_convert.mcps.email.database_utils import EmailDatabase


def ensure_users_exist(db: EmailDatabase, users_info: List[Dict]) -> bool:
    """Ensure users exist in the database"""
    print(f"👥 Ensuring {len(users_info)} users exist in the database...")
    
    try:
        # Read or initialize users.json
        if not db.users:
            db.users = {}
        
        for user_info in users_info:
            email = user_info['email']
            password = user_info.get('password', 'default_password')
            name = user_info.get('name', email.split('@')[0])
            
            # If user does not exist, add them
            if email not in db.users:
                db.users[email] = {
                    "email": email,
                    "password": password,
                    "name": name
                }
                print(f"   ✓ Created user: {name} ({email})")
            else:
                # Update password and name
                db.users[email]["password"] = password
                db.users[email]["name"] = name
                print(f"   ✓ Updated user: {name} ({email})")
        
        # Save users.json
        db._save_json_file("users.json", db.users)
        print(f"✅ User data saved")
        
        return True
    except Exception as e:
        print(f"❌ User initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def clear_email_database(db: EmailDatabase, user_email: str) -> bool:
    """Clear email data for a specified user"""
    print(f"🗑️  Clearing email database: {user_email}...")
    
    try:
        # Get user data directory
        user_dir = db._get_user_data_dir(user_email)

        # If user data does not exist, create empty ones
        if not Path(user_dir).exists():
            Path(user_dir).mkdir(parents=True, exist_ok=True)
            # Create empty emails, folders, and drafts files
            db._save_json_file(os.path.join(user_dir, "emails.json"), {})
            db._save_json_file(os.path.join(user_dir, "folders.json"), {
                "INBOX": {"total": 0, "unread": 0},
                "Sent": {"total": 0, "unread": 0},
                "Trash": {"total": 0, "unread": 0}
            })
            db._save_json_file(os.path.join(user_dir, "drafts.json"), {})
            print(f"   ✓ Created new user data: {user_email}")
        else:
            # Clear existing data
            db._save_json_file(os.path.join(user_dir, "emails.json"), {})
            db._save_json_file(os.path.join(user_dir, "folders.json"), {
                "INBOX": {"total": 0, "unread": 0},
                "Sent": {"total": 0, "unread": 0},
                "Trash": {"total": 0, "unread": 0}
            })
            db._save_json_file(os.path.join(user_dir, "drafts.json"), {})
            print(f"   ✓ Cleanup complete: {user_email}")
        
        return True
    except Exception as e:
        print(f"   ❌ Cleanup failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def import_emails_to_database(db: EmailDatabase, receiver_email: str, backup_file: Path) -> bool:
    """Import emails from backup file to database"""
    print(f"📨 Importing emails from backup file to database...")
    print(f"   Backup file: {backup_file}")
    print(f"   Receiver: {receiver_email}")
    
    try:
        # Read backup file
        with open(backup_file, 'r', encoding='utf-8') as f:
            backup_data = json.load(f)

        emails = backup_data.get('emails', [])
        print(f"   📧 Found {len(emails)} emails")

        # Get receiver's user data directory
        user_dir = db._get_user_data_dir(receiver_email)
        emails_file = os.path.join(user_dir, "emails.json")
        folders_file = os.path.join(user_dir, "folders.json")
        
        # Load existing email data
        try:
            with open(emails_file, 'r', encoding='utf-8') as f:
                emails_data = json.load(f)
        except:
            emails_data = {}

        # Load existing folder data
        try:
            with open(folders_file, 'r', encoding='utf-8') as f:
                folders_data = json.load(f)
        except:
            folders_data = {
                "INBOX": {"total": 0, "unread": 0},
                "Sent": {"total": 0, "unread": 0},
                "Trash": {"total": 0, "unread": 0}
            }
        
        # Import emails
        imported_count = 0
        for email in emails:
            email_id = email.get('email_id')
            folder = email.get('folder', 'INBOX')
            is_read = email.get('is_read', False)

            # Add email to database
            emails_data[email_id] = {
                'id': email_id,
                'subject': email.get('subject', ''),
                'from': email.get('from_addr', ''),
                'to': email.get('to_addr', receiver_email),
                'cc': email.get('cc_addr'),
                'bcc': email.get('bcc_addr'),
                'date': email.get('date', ''),
                'message_id': email.get('message_id', ''),
                'body': email.get('body_text', ''),
                'html_body': email.get('body_html', ''),
                'is_read': is_read,
                'is_important': email.get('is_important', False),
                'folder': folder,
                'attachments': email.get('attachments', [])
            }
            
            # Update folder count
            if folder not in folders_data:
                folders_data[folder] = {"total": 0, "unread": 0}
            
            folders_data[folder]["total"] += 1
            if not is_read:
                folders_data[folder]["unread"] += 1
            
            imported_count += 1
            print(f"   ✓ [{imported_count}/{len(emails)}] Imported: {email.get('subject', 'No Subject')}")
        
        # Save updated data
        db._save_json_file(emails_file, emails_data)
        db._save_json_file(folders_file, folders_data)

        print(f"\n✅ Successfully imported {imported_count} emails")
        return True
        
    except Exception as e:
        print(f"   ❌ Email import failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_config(task_dir: Path,
                    num_professors: int = 3,
                    structure: str = "standard",
                    receiver_idx: int = 0,
                    seed: int = 42,
                    num_positive: int = 2,
                    positive_weight: float = 1.0,
                    research_assistant_weight: float = 1.0,
                    no_spots_weight: float = 1.0,
                    no_response_weight: float = 1.0,
                    assign_different_structures: bool = True) -> bool:
    """Generate task configuration"""
    print("\n📝 Step 0: Generating task configuration...")
    print("=" * 60)

    # Configuration generator script path
    generator_script = task_dir / "generate_task_config.py"

    if not generator_script.exists():
        print(f"❌ Configuration generator script not found: {generator_script}")
        return False

    # Build command
    import subprocess
    cmd = [
        sys.executable,
        str(generator_script),
        "--num-professors", str(num_professors),
        "--structure", structure,
        "--receiver-idx", str(receiver_idx),
        "--seed", str(seed),
        "--num-positive", str(num_positive),
        "--positive-weight", str(positive_weight),
        "--research-assistant-weight", str(research_assistant_weight),
        "--no-spots-weight", str(no_spots_weight),
        "--no-response-weight", str(no_response_weight),
        "--output-dir", str(task_dir)
    ]
    
    # Add parameter for assigning different structures
    if assign_different_structures:
        cmd.append("--assign-different-structures")

    print(f"🎲 Generation parameters:")
    print(f"   Number of professors: {num_professors}")
    print(f"   File structure: {structure}")
    print(f"   Assign different structures: {assign_different_structures}")
    print(f"   Receiver index: {receiver_idx}")
    print(f"   Random seed: {seed}")
    print(f"   Number of positive replies: {num_positive}")
    print(f"   Reply type weights:")
    print(f"      Positive reply: {positive_weight}")
    print(f"      Research assistant: {research_assistant_weight}")
    print(f"      No spots: {no_spots_weight}")
    print(f"      No response: {no_response_weight}")
    
    try:
        # Run configuration generator script
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(task_dir)
        )

        # Output the generator script's output
        if result.stdout:
            print(result.stdout)

        if result.returncode != 0:
            print(f"❌ Configuration generation failed:")
            if result.stderr:
                print(result.stderr)
            return False

        print("✅ Configuration generated successfully!")
        return True

    except Exception as e:
        print(f"❌ Configuration generation exception: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__=="__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--launch_time", required=False, help="Launch time")
    
    # Configuration generation parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip configuration generation, use existing files")
    parser.add_argument("--num-professors", type=int, default=10,
                       help="Number of professors (default: 3)")
    parser.add_argument("--structure", type=str, default="standard",
                       choices=["standard", "variant1", "variant2", "variant3", "variant4", "variant5"],
                       help="File structure type (default: standard)")
    parser.add_argument("--receiver-idx", type=int, default=0,
                       help="Receiver index (default: 0)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")
    parser.add_argument("--no-assign-different-structures", action="store_false",
                       dest="assign_different_structures",
                       help="Disable assigning different file structures to each positive professor (enabled by default)")

    # Reply type control parameters
    parser.add_argument("--num-positive", type=int, default=1,
                       help="Number of professors with positive replies (default: 2)")
    parser.add_argument("--positive-weight", type=float, default=1.0,
                       help="Weight for positive replies (default: 1.0)")
    parser.add_argument("--research-assistant-weight", type=float, default=1.0,
                       help="Weight for research assistant replies (default: 1.0)")
    parser.add_argument("--no-spots-weight", type=float, default=1.0,
                       help="Weight for no spots replies (default: 1.0)")
    parser.add_argument("--no-response-weight", type=float, default=1.0,
                       help="Weight for no response (default: 1.0)")
    parser.add_argument("--task-root", type=str, default=None,
                       help="Task root directory path (if not specified, derived from __file__)")

    args = parser.parse_args()
    
    # First handle file extraction (if agent_workspace is specified)
    if args.agent_workspace:
        # Ensure agent workspace exists
        os.makedirs(args.agent_workspace, exist_ok=True)
        dst_tar_path = os.path.join(args.agent_workspace, "files.tar.gz")

        # Extract files
        try:
            with tarfile.open(dst_tar_path, 'r:gz') as tar:
                print(f"Extracting application files to: {args.agent_workspace}")
                # Try to use filter parameter for Python 3.12+, fall back for older versions
                try:
                    tar.extractall(path=args.agent_workspace, filter='data')
                except TypeError:
                    # Fall back to no filter for Python < 3.12
                    tar.extractall(path=args.agent_workspace)
                print("Extraction complete")
        except Exception as e:
            print(f"Extraction failed: {e}")
            # Continue execution, as files may already exist or extraction may not be needed

        # Delete compressed file
        try:
            os.remove(dst_tar_path)
            print(f"Deleted original compressed file: {dst_tar_path}")
        except Exception as e:
            print(f"Failed to delete compressed file: {e}")

    print("\n" + "=" * 60)
    print("🚀 PhD Application Email Task Environment Preprocessing Started")
    print("=" * 60)
    print("Preprocessing...")
    print("Using local database email import mode")

    # Get task root directory
    if args.task_root:
        task_root = Path(args.task_root)
    else:
        task_root = Path(__file__).parent.parent

    # Step 0: Generate task configuration (optional)
    if not args.skip_generation:
        if not generate_config(
            task_root,
            num_professors=args.num_professors,
            structure=args.structure,
            receiver_idx=args.receiver_idx,
            seed=args.seed,
            num_positive=args.num_positive,
            positive_weight=args.positive_weight,
            research_assistant_weight=args.research_assistant_weight,
            no_spots_weight=args.no_spots_weight,
            no_response_weight=args.no_response_weight,
            assign_different_structures=args.assign_different_structures
        ):
            print("❌ Configuration generation failed, terminating preprocessing")
            sys.exit(1)
    else:
        print("\n📝 Step 0: Skipping configuration generation, using existing configuration")
        print("=" * 60)

    # Get task email backup file path
    task_backup_file = task_root / "files" / "emails_backup.json"
    email_config_file = task_root / "email_config.json"
    receiver_config_file = task_root / "files" / "receiver_config.json"

    if not task_backup_file.exists():
        print("❌ Task email backup file not found")
        print("💡 Please run configuration generation first or ensure emails_backup.json file exists")
        sys.exit(1)

    if not email_config_file.exists():
        print("❌ Email configuration file email_config.json not found")
        sys.exit(1)

    if not receiver_config_file.exists():
        print("❌ Receiver configuration file receiver_config.json not found")
        sys.exit(1)

    # Read actual email account configuration (email_config.json)
    print("\n📧 Reading email account configuration...")
    print("=" * 60)
    with open(email_config_file, 'r', encoding='utf-8') as f:
        email_config = json.load(f)
    
    # Actual email receiving account (maryc@mcp.com)
    actual_receiver_email = email_config['email']
    actual_receiver_password = email_config['password']
    actual_receiver_name = email_config['name']

    print(f"   Actual receiving account: {actual_receiver_name} ({actual_receiver_email})")

    # Read receiver configuration in email content (receiver_config.json)
    with open(receiver_config_file, 'r', encoding='utf-8') as f:
        receiver_config = json.load(f)

    # Receiver mentioned in email content (myersj@mcp.com)
    content_receiver_email = receiver_config['email']
    content_receiver_password = receiver_config['password']
    content_receiver_name = receiver_config['name']

    print(f"   Email content receiver: {content_receiver_name} ({content_receiver_email})")

    # Initialize email database
    print("\n📧 Initializing email database...")
    print("=" * 60)

    # Determine email database directory
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        email_db_dir = str(workspace_parent / "local_db" / "emails")
    else:
        email_db_dir = str(Path(__file__).parent.parent / "local_db" / "emails")
    
    print(f"📂 Email database directory: {email_db_dir}")
    Path(email_db_dir).mkdir(parents=True, exist_ok=True)

    # Initialize EmailDatabase
    email_db = EmailDatabase(data_dir=email_db_dir)

    # Read sender emails from backup file
    print("\n📧 Reading sender information...")
    print("=" * 60)
    with open(task_backup_file, 'r', encoding='utf-8') as f:
        backup_data = json.load(f)
    
    # Extract all senders from emails
    senders = set()
    for email in backup_data.get('emails', []):
        sender = email.get('from_addr', '')
        if sender:
            senders.add(sender)

    print(f"   Found {len(senders)} senders")

    # Prepare user information (including actual receiver, content receiver, and all senders)
    users_info = [
        {"email": actual_receiver_email, "password": actual_receiver_password, "name": actual_receiver_name},
        {"email": content_receiver_email, "password": content_receiver_password, "name": content_receiver_name}
    ]
    
    # Create user for each sender (using default password)
    for sender in senders:
        name = sender.split('@')[0]
        users_info.append({
            "email": sender,
            "password": "default_password",
            "name": name
        })

    # Ensure all users exist in database
    print("\n👥 Step 1: Creating database users...")
    print("=" * 60)
    if not ensure_users_exist(email_db, users_info):
        print("❌ User initialization failed")
        sys.exit(1)

    # Clear email data for all users (actual receiver, content receiver, and senders)
    print(f"\n🗑️  Step 2: Clearing all user email databases...")
    print("=" * 60)

    # Collect all emails to clean
    emails_to_clean = [actual_receiver_email, content_receiver_email] + list(senders)
    print(f"   Will clean {len(emails_to_clean)} mailboxes")
    
    all_success = True
    for email in emails_to_clean:
        if not clear_email_database(email_db, email):
            print(f"⚠️  Mailbox {email} cleanup failed")
            all_success = False

    if all_success:
        print("✅ All email databases cleaned")
    else:
        print("⚠️ Some email database cleanups were not fully successful, but continuing execution")

    # Import emails to database (import to actual receiving account maryc@mcp.com)
    print(f"\n📨 Step 3: Importing emails to database...")
    print("=" * 60)
    if not import_emails_to_database(email_db, actual_receiver_email, task_backup_file):
        print("\n❌ Email import failed!")
        sys.exit(1)

    # Set environment variable for evaluation use
    os.environ['EMAIL_DATA_DIR'] = email_db_dir

    print("\n" + "=" * 60)
    print("🎉 PhD Application Email Task Environment Preprocessing Complete!")
    print("=" * 60)
    print(f"✅ Email database initialization complete")
    print(f"✅ {len(users_info)} users created")
    print(f"✅ All user mailboxes cleaned")
    print(f"✅ Emails imported to database")
    print(f"\n📂 Directory locations:")
    print(f"   Email database: {email_db_dir}")
    print(f"\n📧 Actual receiving email account (for login):")
    print(f"   Email: {actual_receiver_email}")
    print(f"   Password: {actual_receiver_password}")
    print(f"   Name: {actual_receiver_name}")
    print(f"\n📧 Receiver in email content:")
    print(f"   Email: {content_receiver_email}")
    print(f"   Name: {content_receiver_name}")
    print(f"\n💡 Next step: Agent needs to analyze emails and prepare application materials")