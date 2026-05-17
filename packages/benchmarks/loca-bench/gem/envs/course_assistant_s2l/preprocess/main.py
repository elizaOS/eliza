import asyncio
from argparse import ArgumentParser
from pathlib import Path
from time import sleep
import sys
import subprocess
import json
import os
import shutil
from datetime import datetime, timezone
from typing import List, Dict
from gem.utils.filesystem import nfs_safe_rmtree

# Add current directory to path for importing local modules
current_dir = Path(__file__).parent
sys.path.insert(0, str(current_dir))


from mcp_convert.mcps.email.database_utils import EmailDatabase


def clear_initial_workspace(task_root: Path) -> bool:
    """Clear the initial_workspace directory"""
    initial_workspace = task_root / "initial_workspace"

    print(f"🗑️  Clearing initial_workspace directory...")
    
    try:
        if initial_workspace.exists():
            # Delete all contents in the directory
            for item in initial_workspace.iterdir():
                if item.is_file():
                    item.unlink()
                    print(f"   ✓ Deleted file: {item.name}")
                elif item.is_dir():
                    nfs_safe_rmtree(item)
                    print(f"   ✓ Deleted directory: {item.name}")
        else:
            # If directory doesn't exist, create it
            initial_workspace.mkdir(parents=True, exist_ok=True)
            print(f"   ✓ Created directory: {initial_workspace}")

        print("✅ initial_workspace cleared")
        return True
    except Exception as e:
        print(f"❌ Failed to clear initial_workspace: {e}")
        import traceback
        traceback.print_exc()
        return False


def copy_initial_workspace_to_agent(task_root: Path, agent_workspace: str) -> bool:
    """Copy initial_workspace to agent_workspace"""
    initial_workspace = task_root / "initial_workspace"
    agent_workspace_path = Path(agent_workspace)

    print(f"\n📂 Copying initial_workspace to agent_workspace...")
    print(f"   Source directory: {initial_workspace}")
    print(f"   Target directory: {agent_workspace_path}")
    
    try:
        if not initial_workspace.exists():
            print(f"❌ initial_workspace does not exist: {initial_workspace}")
            return False

        # Ensure agent_workspace exists
        agent_workspace_path.mkdir(parents=True, exist_ok=True)

        # Copy all files and subdirectories
        copied_count = 0
        for item in initial_workspace.iterdir():
            dest = agent_workspace_path / item.name

            if item.is_file():
                shutil.copy2(item, dest)
                print(f"   ✓ Copied file: {item.name}")
                copied_count += 1
            elif item.is_dir():
                if dest.exists():
                    nfs_safe_rmtree(dest)
                shutil.copytree(item, dest)
                print(f"   ✓ Copied directory: {item.name}")
                copied_count += 1

        print(f"✅ Successfully copied {copied_count} items to agent_workspace")
        return True
    except Exception as e:
        print(f"❌ Copy failed: {e}")
        import traceback
        traceback.print_exc()
        return False


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

            # If user doesn't exist, add them
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


def clear_email_database(db: EmailDatabase, user_emails: List[str]) -> bool:
    """Clear email data for specified users"""
    print(f"🗑️  Clearing database for {len(user_emails)} mailboxes...")
    
    try:
        for user_email in user_emails:
            # Get user data directory
            user_dir = db._get_user_data_dir(user_email)

            # If user data doesn't exist, create empty files
            if not Path(user_dir).exists():
                Path(user_dir).mkdir(parents=True, exist_ok=True)
                # Create empty email, folder and draft files
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
                print(f"   ✓ Cleared: {user_email}")

        return True
    except Exception as e:
        print(f"   ❌ Clear failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def send_emails_via_database(db: EmailDatabase,
                             sender_email: str,
                             receiver_email: str,
                             emails_jsonl_path: Path) -> bool:
    """Send emails by directly operating on the database"""
    print(f"📨 Sending emails via database...")
    
    try:
        # Login to sender account
        sender_user = db.users.get(sender_email)
        if not sender_user:
            print(f"   ❌ Sender does not exist: {sender_email}")
            return False

        # Check if receiver exists
        receiver_user = db.users.get(receiver_email)
        if not receiver_user:
            print(f"   ❌ Receiver does not exist: {receiver_email}")
            return False

        # Set current user
        db.current_user_email = sender_email
        db.authenticated = True
        db._load_user_data(sender_email)

        # Read email data
        emails_data = []
        with open(emails_jsonl_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    email_data = json.loads(line)
                    emails_data.append(email_data)
                except json.JSONDecodeError:
                    continue

        print(f"   📧 Preparing to send {len(emails_data)} emails")
        
        # Send each email
        sent_count = 0
        for i, email_data in enumerate(emails_data, 1):
            try:
                sender_name = email_data.get('sender_name', 'Student')
                subject = email_data.get('subject', 'No Subject')
                content = email_data.get('content', '')
                content_type = email_data.get('content_type', 'plain')

                # Use EmailDatabase's send_email method
                html_body = content if content_type == 'html' else None
                plain_body = content if content_type == 'plain' else None

                email_result = db.send_email(
                    to=receiver_email,
                    subject=subject,
                    body=plain_body or content,
                    html_body=html_body
                )

                sent_count += 1
                print(f"   ✓ [{i}/{len(emails_data)}] {sender_name}: {subject}")

                # Small delay to maintain time order
                sleep(0.1)

            except Exception as e:
                print(f"   ❌ [{i}/{len(emails_data)}] Send failed: {e}")
                continue

        print(f"\n✅ Successfully sent {sent_count}/{len(emails_data)} emails")
        return sent_count == len(emails_data)

    except Exception as e:
        print(f"   ❌ Email sending failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_config(task_dir: Path,
                    email_db: EmailDatabase,
                    sender_email: str,
                    sender_password: str,
                    sender_name: str,
                    receiver_email: str,
                    receiver_password: str,
                    receiver_name: str,
                    num_students: int = 15,
                    dropout_rate: float = 0.1,
                    submission_rate: float = 0.7,
                    num_check: int = 2,
                    seed: int = 42):
    """Generate task configuration and create database users"""
    print("\n📝 Step 0: Generating task configuration...")
    print("=" * 60)
    
    # Config generation script path - for environment, it's in the parent directory
    # task_dir is where we want to save the output, but the script is in the env dir
    env_dir = Path(__file__).parent.parent  # course_assistant_s2l env directory
    generator_script = env_dir / "generate_task_config.py"
    
    if not generator_script.exists():
        print(f"❌ Configuration generation script does not exist: {generator_script}")
        return False

    # Build command
    cmd = [
        sys.executable,
        str(generator_script),
        "--num-students", str(num_students),
        "--dropout-rate", str(dropout_rate),
        "--submission-rate", str(submission_rate),
        "--num-check", str(num_check),
        "--seed", str(seed),
        "--output-dir", str(task_dir)
    ]

    print(f"🎲 Generation parameters:")
    print(f"   Total students: {num_students}")
    print(f"   Dropout rate: {dropout_rate:.0%}")
    print(f"   Submission rate: {submission_rate:.0%}")
    print(f"   Check students count: {num_check}")
    print(f"   Random seed: {seed}")
    
    try:
        # Run configuration generation script
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(task_dir)
        )

        # Output from generation script
        if result.stdout:
            print(result.stdout)

        if result.returncode != 0:
            print(f"❌ Configuration generation failed:")
            if result.stderr:
                print(result.stderr)
            return False

        print("✅ Configuration generated successfully!")

        # Immediately read generated student configuration and create database users
        print("\n👥 Creating database users...")
        check_students = read_evaluation_check_students(task_dir)

        # Prepare all required user information
        users_info = [
            {"email": sender_email, "password": sender_password, "name": sender_name},
            {"email": receiver_email, "password": receiver_password, "name": receiver_name}
        ]
        users_info.extend([
            {"email": s['email'], "password": s['password'], "name": s['name']}
            for s in check_students
        ])

        # Ensure all users exist in database
        if not ensure_users_exist(email_db, users_info):
            print("❌ User creation failed")
            return False

        print(f"✅ Successfully created {len(users_info)} database users")
        return True

    except Exception as e:
        print(f"❌ Configuration generation exception: {e}")
        import traceback
        traceback.print_exc()
        return False


def load_students_from_emails_jsonl(jsonl_path: Path):
    """Read student information from emails.jsonl (students who submitted)"""
    students = []
    if not jsonl_path.exists():
        return students
    
    with open(jsonl_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                email_data = json.loads(line)
                # Extract student ID from subject: nlp-presentation-{student_id}-{name}
                subject = email_data.get('subject', '')
                parts = subject.split('-')
                if len(parts) >= 3:
                    student_id = parts[2]
                    name = email_data.get('sender_name', '')
                    students.append({
                        'name': name,
                        'student_id': student_id
                    })
            except json.JSONDecodeError:
                continue
    
    return students


def read_evaluation_check_students(task_dir: Path):
    """Read students to check from students_info.json and emails.jsonl (enrolled students who haven't submitted)"""
    students = []

    # Read complete student information (including passwords)
    students_info_path = task_dir / "files" / "students_info.json"
    if not students_info_path.exists():
        print(f"⚠️  Student info file does not exist: {students_info_path}")
        return []

    try:
        with open(students_info_path, 'r', encoding='utf-8') as f:
            all_students = json.load(f)
    except Exception as e:
        print(f"⚠️  Failed to read student info: {e}")
        return []

    # Read emails.jsonl to get submitted students
    emails_jsonl = task_dir / "files" / "emails.jsonl"
    submitted_student_ids = set()
    if emails_jsonl.exists():
        with open(emails_jsonl, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    email_data = json.loads(line)
                    # Extract student ID from subject
                    subject = email_data.get('subject', '')
                    import re
                    match = re.search(r'nlp-presentation-(\d+)-', subject)
                    if match:
                        submitted_student_ids.add(match.group(1))
                except:
                    continue

    # Filter enrolled students who haven't submitted
    for student in all_students:
        student_id = student['student_id']
        status = student.get('status', 'enrolled')

        # Only get enrolled students who haven't submitted
        if status != 'dropped' and student_id not in submitted_student_ids:
            students.append({
                'name': student['name'],
                'email': student['email'],
                'password': student['password'],
                'student_id': student_id
            })
    
    return students


def save_teacher_email_account(task_root: Path, email: str, password: str) -> bool:
    """Save teacher's email account information to initial_workspace/email_account.txt"""
    print(f"\n💾 Saving teacher email account information...")
    
    try:
        initial_workspace = task_root / "initial_workspace"
        email_account_file = initial_workspace / "email_account.txt"

        # Ensure initial_workspace directory exists
        initial_workspace.mkdir(parents=True, exist_ok=True)

        # Write email account information
        with open(email_account_file, 'w', encoding='utf-8') as f:
            f.write(f"Email: {email}\n")
            f.write(f"Password: {password}\n")

        print(f"   ✓ Email account info saved to: {email_account_file}")
        return True
    except Exception as e:
        print(f"   ❌ Save failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__=="__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--launch_time", required=False, help="Launch time")
    parser.add_argument("--task-root", required=False, help="Task root directory (for multi-instance isolation)")

    # Configuration generation parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip configuration generation, use existing files")
    parser.add_argument("--num-students", type=int, default=50,
                       help="Total number of students (default: 25)")
    parser.add_argument("--dropout-rate", type=float, default=0.1,
                       help="Dropout rate (0-1, default: 0.2)")
    parser.add_argument("--submission-rate", type=float, default=0.5,
                       help="Assignment submission rate (0-1, default: 0.7)")
    parser.add_argument("--num-check", type=int, default=2,
                       help="Number of students to check (default: 2)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")
    
    args = parser.parse_args()

    # Get task root directory
    # If task-root is specified, use it; otherwise use environment directory as fallback
    if args.task_root:
        task_root = Path(args.task_root)
    else:
        task_root = Path(__file__).parent.parent

    print("\n" + "=" * 60)
    print("🚀 Course Assistant task environment preprocessing started")
    print("=" * 60)

    # Step -1: Clear initial_workspace
    print("\n📁 Step -1: Clearing initial_workspace...")
    print("=" * 60)
    if not clear_initial_workspace(task_root):
        print("❌ Failed to clear initial_workspace, terminating preprocessing")
        sys.exit(1)

    # Initialize email database (before configuration generation)
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

    # Email configuration
    sender_email = "mcooper@mcp.com"
    sender_password = "maria_89vHV7"
    sender_name = "NLP Course Student"

    receiver_email = "virginia_diaz@mcp.com"
    receiver_password = "virginia_85W"
    receiver_name = "NLP Course Assistant"

    # Step 0: Generate task configuration (optional)
    if not args.skip_generation:
        if not generate_config(
            task_root,
            email_db,
            sender_email,
            sender_password,
            sender_name,
            receiver_email,
            receiver_password,
            receiver_name,
            num_students=args.num_students,
            dropout_rate=args.dropout_rate,
            submission_rate=args.submission_rate,
            num_check=args.num_check,
            seed=args.seed
        ):
            print("❌ Configuration generation failed, terminating preprocessing")
            sys.exit(1)
    else:
        print("\n📝 Step 0: Skipping configuration generation, using existing configuration")
        print("=" * 60)

        # Even if skipping generation, ensure users exist
        print("\n👥 Step 1: Ensuring users exist in database...")
        print("=" * 60)

        check_students = read_evaluation_check_students(task_root)

        users_info = [
            {"email": sender_email, "password": sender_password, "name": sender_name},
            {"email": receiver_email, "password": receiver_password, "name": receiver_name}
        ]
        users_info.extend([
            {"email": s['email'], "password": s['password'], "name": s['name']}
            for s in check_students
        ])

        if not ensure_users_exist(email_db, users_info):
            print("❌ User initialization failed")
            sys.exit(1)

    # Read student emails to clean (from Excel and emails.jsonl)
    check_students = read_evaluation_check_students(task_root)

    print(f"\n✅ Read {len(check_students)} students to check from evaluation configuration")
    for student in check_students:
        print(f"   • {student['name']}: {student['email']}")

    # Prepare list of mailboxes to clean (users already created in step 0)
    emails_to_clean = [sender_email, receiver_email]
    emails_to_clean.extend([s['email'] for s in check_students])

    print(f"\n🗑️  Step 2: Clearing {len(emails_to_clean)} mailbox databases...")
    print("=" * 60)

    # Clear email database
    if not clear_email_database(email_db, emails_to_clean):
        print("⚠️ Email database clearing not fully successful, but continuing")
    else:
        print("✅ Email database clearing completed")

    print(f"\n📨 Step 3: Sending emails to database...")
    print("=" * 60)
    print(f"📧 Email sending configuration:")
    print(f"   Sender: {sender_email}")
    print(f"   Receiver: {receiver_email}")

    # Email data file path
    email_jsonl_file = task_root / "files" / "emails.jsonl"

    # Check if email file exists
    if not email_jsonl_file.exists():
        print(f"❌ Error: Email data file does not exist: {email_jsonl_file}")
        print("💡 Please ensure configuration generation script has been run")
        sys.exit(1)

    # Count emails
    num_emails = 0
    with open(email_jsonl_file, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                num_emails += 1

    print(f"🚀 Sending {num_emails} emails via database...")
    print(f"   Email data: {email_jsonl_file}")

    # Send emails via database
    if not send_emails_via_database(email_db, sender_email, receiver_email, email_jsonl_file):
        print("❌ Email sending failed")
        sys.exit(1)

    # Save teacher email account to initial_workspace
    print(f"\n📝 Step 3.5: Saving teacher email account information...")
    print("=" * 60)
    if not save_teacher_email_account(task_root, receiver_email, receiver_password):
        print("⚠️  Failed to save teacher email account information, but continuing")
    else:
        print("✅ Teacher email account information saved")

    # Set environment variable for evaluation use
    os.environ['EMAIL_DATA_DIR'] = email_db_dir

    # Write environment variable file
    env_file = Path(email_db_dir).parent / ".email_env"
    try:
        with open(env_file, 'w') as f:
            f.write(f"# Email Database Environment Variables\\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\\n")
            f.write(f"export EMAIL_DATA_DIR={email_db_dir}\\n")
        print(f"📄 Environment variable file created: {env_file}")
    except Exception as e:
        print(f"⚠️  Unable to create environment variable file: {e}")

    # Step 4: Copy initial_workspace to agent_workspace
    if args.agent_workspace:
        print(f"\n📋 Step 4: Copying initial_workspace to agent_workspace...")
        print("=" * 60)
        if not copy_initial_workspace_to_agent(task_root, args.agent_workspace):
            print("⚠️  Failed to copy initial_workspace, but continuing")
    else:
        print(f"\n⚠️  agent_workspace not specified, skipping copy step")

    print("\\n" + "=" * 60)
    print("🎉 Course Assistant task environment preprocessing completed!")
    print("=" * 60)
    print(f"✅ initial_workspace cleared and new configuration generated")
    print(f"✅ Task configuration generated")
    print(f"✅ {len(emails_to_clean)} mailbox databases cleared")
    print(f"✅ {num_emails} student assignment emails written to database")
    print(f"✅ Teacher email account information saved to email_account.txt")
    print(f"✅ {len(check_students)} students need to receive reminder emails")
    if args.agent_workspace:
        print(f"✅ initial_workspace copied to agent_workspace")
    print(f"\\n📂 Directory locations:")
    print(f"   initial_workspace: {task_root / 'initial_workspace'}")
    if args.agent_workspace:
        print(f"   agent_workspace: {args.agent_workspace}")
    print(f"   Email database: {email_db_dir}")
    print(f"\\n📌 Environment variable set:")
    print(f"   EMAIL_DATA_DIR={email_db_dir}")
    print(f"\\n📧 Teacher email account:")
    print(f"   Email: {receiver_email}")
    print(f"   Password: {receiver_password}")
    print(f"\\n💡 Next step: Agent needs to analyze Excel and send reminder emails to students who haven't submitted assignments")