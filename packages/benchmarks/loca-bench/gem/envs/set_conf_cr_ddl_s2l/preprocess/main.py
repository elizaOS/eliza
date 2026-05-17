import sys
import os
import json
from pathlib import Path
from argparse import ArgumentParser
from datetime import datetime
from typing import List, Dict

# Add mcp_convert path to import database utilities
# Navigate up until we find the directory containing mcp_convert
from mcp_convert.mcps.email.database_utils import EmailDatabase
from mcp_convert.mcps.calendar.database_utils import CalendarDatabase
from gem.utils.filesystem import nfs_safe_rmtree


def ensure_users_exist(db: EmailDatabase, users_info: List[Dict]) -> bool:
    """Ensure users exist in the database"""
    print(f"Ensuring {len(users_info)} users exist in the database...")
    
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
                print(f"   Created user: {name} ({email})")
            else:
                # Update password and name
                db.users[email]["password"] = password
                db.users[email]["name"] = name
                print(f"   Updated user: {name} ({email})")

        # Save users.json
        db._save_json_file("users.json", db.users)
        print(f"User data saved")
        
        return True
    except Exception as e:
        print(f"User initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def clear_email_database(db: EmailDatabase, user_email: str) -> bool:
    """Clear email data for specified user"""
    print(f"Cleaning email database: {user_email}...")
    
    try:
        # Get user data directory
        user_dir = db._get_user_data_dir(user_email)

        # If user data doesn't exist, create empty
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
            print(f"   Created new user data: {user_email}")
        else:
            # Clear existing data
            db._save_json_file(os.path.join(user_dir, "emails.json"), {})
            db._save_json_file(os.path.join(user_dir, "folders.json"), {
                "INBOX": {"total": 0, "unread": 0},
                "Sent": {"total": 0, "unread": 0},
                "Trash": {"total": 0, "unread": 0}
            })
            db._save_json_file(os.path.join(user_dir, "drafts.json"), {})
            print(f"   Cleanup completed: {user_email}")
        
        return True
    except Exception as e:
        print(f"   Cleanup failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def clear_calendar_database(calendar_db: CalendarDatabase) -> bool:
    """Clear all events from Calendar database"""
    print(f"Cleaning Calendar database...")
    
    try:
        # Get all events
        all_events = calendar_db.list_events(
            time_min="2020-01-01T00:00:00Z",
            time_max="2030-12-31T23:59:59Z"
        )
        
        print(f"   Found {len(all_events)} existing events to delete")
        
        # Delete each event
        deleted_count = 0
        for event in all_events:
            try:
                event_id = event.get('id')
                event_title = event.get('summary', 'Untitled')
                
                if event_id:
                    success = calendar_db.delete_event(event_id)
                    if success:
                        deleted_count += 1
                        print(f"   Deleted: {event_title}")
                    else:
                        print(f"   Warning: Failed to delete event '{event_title}'")
            except Exception as e:
                print(f"   Warning: Failed to delete event: {e}")
                continue
        
        print(f"Successfully deleted {deleted_count} events")
        print("Calendar database cleanup completed")
        return True
        
    except Exception as e:
        print(f"Calendar cleanup failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def clear_database_folders(email_db_dir: str, calendar_db_dir: str) -> bool:
    """Clear Email and Calendar database folders"""
    import shutil

    print(f"\nClearing database folders...")
    print("=" * 60)
    
    try:
        email_path = Path(email_db_dir)
        calendar_path = Path(calendar_db_dir)
        
        # Clear Email database folder
        if email_path.exists():
            print(f"   Deleting Email database folder: {email_path}")
            nfs_safe_rmtree(email_path)
            print(f"   Email folder deleted")
        else:
            print(f"   Email folder doesn't exist, skipping deletion")

        # Clear Calendar database folder
        if calendar_path.exists():
            print(f"   Deleting Calendar database folder: {calendar_path}")
            nfs_safe_rmtree(calendar_path)
            print(f"   Calendar folder deleted")
        else:
            print(f"   Calendar folder doesn't exist, skipping deletion")

        print(f"Database folders cleared successfully")
        return True
        
    except Exception as e:
        print(f"Failed to clear folders: {e}")
        import traceback
        traceback.print_exc()
        return False


def copy_initial_workspace_to_agent(task_root: Path, agent_workspace: str) -> bool:
    """Copy initial_workspace to agent_workspace"""
    import shutil
    
    initial_workspace = task_root / "initial_workspace"
    agent_workspace_path = Path(agent_workspace)
    
    print(f"\nCopying initial_workspace to agent_workspace...")
    print(f"   Source directory: {initial_workspace}")
    print(f"   Target directory: {agent_workspace_path}")
    
    try:
        if not initial_workspace.exists():
            print(f"initial_workspace doesn't exist: {initial_workspace}")
            return False
        
    # Ensure agent_workspace exists
        agent_workspace_path.mkdir(parents=True, exist_ok=True)
        
        # Copy all files
        copied_count = 0
        for item in initial_workspace.iterdir():
            dest = agent_workspace_path / item.name

            if item.is_file():
                shutil.copy2(item, dest)
                print(f"   Copied file: {item.name}")
                copied_count += 1
            elif item.is_dir():
                if dest.exists():
                    nfs_safe_rmtree(dest)
                shutil.copytree(item, dest)
                print(f"   Copied directory: {item.name}")
                copied_count += 1

        print(f"Successfully copied {copied_count} items to agent_workspace")
        return True
    except Exception as e:
        print(f"Copy failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def import_emails_to_database(db: EmailDatabase, receiver_email: str, backup_file: Path) -> bool:
    """Import emails from backup file to database"""
    print(f"Importing emails from backup file to database...")
    print(f"   Backup file: {backup_file}")
    print(f"   Recipient: {receiver_email}")
    
    try:
        # Read backup file
        with open(backup_file, 'r', encoding='utf-8') as f:
            backup_data = json.load(f)
        
        emails = backup_data.get('emails', [])
        print(f"   Found {len(emails)} emails")
        
        # Get recipient's user data directory
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

            # Update folder counts
            if folder not in folders_data:
                folders_data[folder] = {"total": 0, "unread": 0}

            folders_data[folder]["total"] += 1
            if not is_read:
                folders_data[folder]["unread"] += 1

            imported_count += 1
            print(f"   [{imported_count}/{len(emails)}] Importing: {email.get('subject', 'No Subject')}")
        
        # Save updated data
        db._save_json_file(emails_file, emails_data)
        db._save_json_file(folders_file, folders_data)

        print(f"\nSuccessfully imported {imported_count} emails")
        return True

    except Exception as e:
        print(f"   Email import failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_conference_emails(task_root: Path,
                              num_target: int = 1,
                              num_noise: int = 2,
                              noise_emails: int = 2,
                              max_conferences: int = 200,
                              enable_reminders: bool = False,
                              enable_extensions: bool = False,
                              base_date: str = '2025-09-15',
                              deadline_offset: int = 15,
                              seed: int = 42,
                              receiver_email: str = 'rkelly27@mcp.com') -> bool:
    """Generate conference emails"""
    print("\nStep 0: Generating conference emails...")
    print("=" * 60)
    
    try:
        import subprocess
        
        generator_script = Path(__file__).parent / "generate_conference_emails.py"
        
        if not generator_script.exists():
            print(f"Email generation script doesn't exist: {generator_script}")
            return False
        
        # Build command
        cmd = [
            sys.executable,
            str(generator_script),
            "--num-target", str(num_target),
            "--num-noise", str(num_noise),
            "--noise-emails", str(noise_emails),
            "--max-conferences", str(max_conferences),
            "--seed", str(seed),
            "--base-date", base_date,
            "--deadline-offset", str(deadline_offset),
            "--receiver-email", receiver_email,
            "--output-dir", str(task_root)
        ]
        
        if enable_reminders:
            cmd.append("--enable-reminders")
        if enable_extensions:
            cmd.append("--enable-extensions")
        
        print(f"Generation parameters:")
        print(f"   Conference pool size: {max_conferences}")
        print(f"   Target conferences: {num_target}")
        print(f"   Noise conferences: {num_noise}")
        print(f"   Noise emails/conf: {noise_emails}")
        print(f"   Reminders enabled: {enable_reminders}")
        print(f"   Extensions enabled: {enable_extensions}")
        print(f"   Base date: {base_date}")
        print(f"   Deadline offset: {deadline_offset} days")
        
        # Run generation script
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent)
        )
        
        # Output generation script results
        if result.stdout:
            print(result.stdout)
        
        if result.returncode != 0:
            print(f"Email generation failed:")
            if result.stderr:
                print(result.stderr)
            return False
        
        print("Email generation successful!")
        return True
        
    except Exception as e:
        print(f"Email generation error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__=="__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--launch_time", required=False, help="Launch time")
    parser.add_argument("--task-root", required=False,
                       help="Task root directory (if not specified, uses script location)")
    
    # Email generation parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip email generation, use existing files")
    parser.add_argument("--max-conferences", type=int, default=200,
                       help="Conference pool size (default: 200)")
    parser.add_argument("--num-target", type=int, default=10,
                       help="Number of conferences with camera-ready deadline (default: 20)")
    parser.add_argument("--num-noise", type=int, default=10,
                       help="Number of noise conferences (default: 40)")
    parser.add_argument("--noise-emails", type=int, default=5,
                       help="Number of emails per noise conference (default: 5)")
    parser.add_argument("--disable-reminders", dest="enable_reminders", action="store_false", default=True,
                       help="Disable reminder emails (enabled by default)")
    parser.add_argument("--disable-extensions", dest="enable_extensions", action="store_false", default=True,
                       help="Disable deadline extensions (enabled by default)")
    parser.add_argument("--base-date", type=str, default='2025-09-15',
                       help="Base date (default: 2025-09-15)")
    parser.add_argument("--deadline-offset", type=int, default=15,
                       help="Days from base date to deadline (default: 15)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")

    # Difficulty presets
    parser.add_argument("--difficulty", choices=['easy', 'medium', 'hard', 'expert'],
                       help="Difficulty preset (overrides other parameters)")
    
    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("Starting Conference Reminder Task Environment Preprocessing")
    print("=" * 60)
    print("Using local databases (Email + Calendar)")

    # Get task root directory
    if args.task_root:
        task_root = Path(args.task_root)
    else:
        # If not provided via command line, use path relative to script location (for scenarios placed in agent workspace)
        task_root = Path(__file__).parent.parent
    
    # Read email configuration (before email generation)
    email_config_file = task_root / "email_config.json"
    if not email_config_file.exists():
        print(f"Email configuration file not found: {email_config_file}")
        sys.exit(1)
    
    with open(email_config_file, 'r', encoding='utf-8') as f:
        email_config = json.load(f)
    
    receiver_email = email_config['email']
    receiver_password = email_config['password']
    receiver_name = email_config['name']
    
    # Step 0: Generate conference emails (optional)
    if not args.skip_generation:
        # Apply difficulty preset
        if args.difficulty:
            if args.difficulty == 'easy':
                args.num_target = 1
                args.num_noise = 1
                args.noise_emails = 1
                args.enable_reminders = False
                args.enable_extensions = False
            elif args.difficulty == 'medium':
                args.num_target = 1
                args.num_noise = 2
                args.noise_emails = 2
                args.enable_reminders = True
                args.enable_extensions = False
            elif args.difficulty == 'hard':
                args.num_target = 1
                args.num_noise = 3
                args.noise_emails = 3
                args.enable_reminders = True
                args.enable_extensions = True
            elif args.difficulty == 'expert':
                args.num_target = 2
                args.num_noise = 4
                args.noise_emails = 4
                args.enable_reminders = True
                args.enable_extensions = True
        
        if not generate_conference_emails(
            task_root=task_root,
            num_target=args.num_target,
            num_noise=args.num_noise,
            noise_emails=args.noise_emails,
            max_conferences=args.max_conferences,
            enable_reminders=args.enable_reminders,
            enable_extensions=args.enable_extensions,
            base_date=args.base_date,
            deadline_offset=args.deadline_offset,
            seed=args.seed,
            receiver_email=receiver_email
        ):
            print("Email generation failed, terminating preprocessing")
            sys.exit(1)
    else:
        print("\nStep 0: Skipping email generation, using existing files")
        print("=" * 60)

    # Determine database directories
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        email_db_dir = str(workspace_parent / "local_db" / "emails")
        calendar_db_dir = str(workspace_parent / "local_db" / "calendar")
    else:
        email_db_dir = str(Path(__file__).parent.parent / "local_db" / "emails")
        calendar_db_dir = str(Path(__file__).parent.parent / "local_db" / "calendar")
    
    print(f"\nDatabase directories:")
    print(f"   Email: {email_db_dir}")
    print(f"   Calendar: {calendar_db_dir}")

    # Clear database folders
    if not clear_database_folders(email_db_dir, calendar_db_dir):
        print("Warning: Failed to clear database folders, but continuing execution")

    # Create directories
    Path(email_db_dir).mkdir(parents=True, exist_ok=True)
    Path(calendar_db_dir).mkdir(parents=True, exist_ok=True)
    
    # Initialize databases
    print("\nStep 1: Initializing databases...")
    print("=" * 60)
    email_db = EmailDatabase(data_dir=email_db_dir)
    calendar_db = CalendarDatabase(data_dir=calendar_db_dir)
    print(f"   Receiver account: {receiver_name} ({receiver_email})")

    # Read sender information from backup file
    backup_file = task_root / "files" / "emails_backup.json"
    if not backup_file.exists():
        print(f"Email backup file not found: {backup_file}")
        if not args.skip_generation:
            print("Hint: Email generation may have failed, please check error messages above")
        else:
            print("Hint: Please run email generation first (without --skip-generation)")
        sys.exit(1)

    print("\nStep 2: Reading sender information...")
    print("=" * 60)
    with open(backup_file, 'r', encoding='utf-8') as f:
        backup_data = json.load(f)
    
    # Extract all senders from emails
    senders = set()
    for email in backup_data.get('emails', []):
        sender = email.get('from_addr', '')
        if sender:
            senders.add(sender)

    print(f"   Found {len(senders)} senders")
    print(f"   Total emails: {len(backup_data.get('emails', []))}")

    # Prepare user information (including receiver and all senders)
    users_info = [
        {"email": receiver_email, "password": receiver_password, "name": receiver_name}
    ]
    
    # Create user for each sender (using default password)
    for sender in senders:
        name = sender.split('@')[0]
        users_info.append({
            "email": sender,
            "password": "default_password",
            "name": name
        })
    
    # Step 3: Create database users
    print("\nStep 3: Creating database users...")
    print("=" * 60)
    if not ensure_users_exist(email_db, users_info):
        print("User initialization failed")
        sys.exit(1)

    # Step 4: Clean email database (receiver only)
    print(f"\nStep 4: Cleaning receiver email database...")
    print("=" * 60)
    print(f"   Note: Only creating mailbox folders for receiver, senders don't need them (improves efficiency)")

    # Only clean/create receiver's mailbox
    if not clear_email_database(email_db, receiver_email):
        print(f"Receiver mailbox {receiver_email} cleanup failed")
        sys.exit(1)

    print("Receiver email database cleanup completed")

    # Step 5: Clean Calendar database
    print(f"\nStep 5: Cleaning Calendar database...")
    print("=" * 60)
    if not clear_calendar_database(calendar_db):
        print("Warning: Calendar database cleanup failed, but continuing execution")

    # Step 6: Import emails to database
    print(f"\nStep 6: Importing emails to database...")
    print("=" * 60)
    if not import_emails_to_database(email_db, receiver_email, backup_file):
        print("\nEmail import failed!")
        sys.exit(1)

    # Step 7: Save target conference information to initial_workspace
    print(f"\nStep 7: Saving conference information to initial_workspace...")
    print("=" * 60)
    
    initial_workspace = task_root / "initial_workspace"
    initial_workspace.mkdir(parents=True, exist_ok=True)
    
    # Read target conference information from metadata
    metadata = backup_data.get('metadata', {})
    if metadata:
        target_info = metadata.get('target_info', {})
        target_conferences = target_info.get('conferences', [])
        
        # Save to initial_workspace/conference_info.txt
        # Don't give the answer directly, but prompt to check emails
        conference_info_file = initial_workspace / "conference_info.txt"
        with open(conference_info_file, 'w', encoding='utf-8') as f:
            f.write(f"Conference Tracking Note\n")
            f.write(f"========================\n\n")
            
            if len(target_conferences) == 1:
                conf_info = target_conferences[0]
                f.write(f"You have submitted a paper to the {conf_info['conference']} conference ({conf_info['track']}).\n")
            else:
                f.write(f"You have submitted papers to multiple conferences:\n")
                for conf_info in target_conferences:
                    f.write(f"  • {conf_info['conference']} ({conf_info['track']})\n")
            
            f.write(f"\nPlease check your recent emails for the camera-ready deadline notifications.\n\n")
            f.write(f"Remember to:\n")
            f.write(f"1. Find the latest camera-ready submission deadline(s) from emails\n")
            f.write(f"2. Set calendar reminder(s) 3 hours before each deadline\n")
        
        print(f"   Saved conference information to: {conference_info_file}")
        if len(target_conferences) == 1:
            print(f"   Target conference: {target_conferences[0]['conference']}")
            print(f"   Deadline: {target_conferences[0]['deadline']}")
        else:
            print(f"   Target conference count: {len(target_conferences)}")
            for conf_info in target_conferences:
                print(f"      - {conf_info['conference']} ({conf_info['track']}): {conf_info['deadline']}")
    else:
        print(f"   Warning: metadata not found, skipping save step")

    # Step 7.5: Save groundtruth metadata
    print(f"\nStep 7.5: Saving groundtruth metadata...")
    print("=" * 60)
    
    groundtruth_workspace = task_root / "groundtruth_workspace"
    groundtruth_workspace.mkdir(parents=True, exist_ok=True)
    
    if metadata:
        # Save complete metadata to groundtruth_workspace
        metadata_file = groundtruth_workspace / "conference_metadata.json"
        with open(metadata_file, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)

        print(f"   Saved metadata to: {metadata_file}")
        print(f"   - Target conference count: {metadata.get('target_info', {}).get('count', 0)}")
        print(f"   - Noise conference count: {metadata.get('noise_info', {}).get('count', 0)}")
        print(f"   - Total emails: {metadata.get('total_emails', 0)}")
    else:
        print(f"   Warning: metadata not found, skipping groundtruth save")

    # Step 8: Copy initial_workspace to agent_workspace
    if args.agent_workspace:
        print(f"\nStep 8: Copying initial_workspace to agent_workspace...")
        print("=" * 60)
        if not copy_initial_workspace_to_agent(task_root, args.agent_workspace):
            print("Warning: Failed to copy initial_workspace, but continuing execution")
    else:
        print(f"\nWarning: agent_workspace not specified, skipping copy step")
    
    # Set environment variables for evaluation use
    os.environ['EMAIL_DATA_DIR'] = email_db_dir
    os.environ['CALENDAR_DATA_DIR'] = calendar_db_dir
    
    # Write environment variables file
    env_file = Path(email_db_dir).parent / ".env"
    try:
        with open(env_file, 'w') as f:
            f.write(f"# Email & Calendar Database Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export EMAIL_DATA_DIR={email_db_dir}\n")
            f.write(f"export CALENDAR_DATA_DIR={calendar_db_dir}\n")
        print(f"\nEnvironment variables file created: {env_file}")
    except Exception as e:
        print(f"Warning: Failed to create environment variables file: {e}")
    
    print("\n" + "=" * 60)
    print("Conference Reminder Task Environment Preprocessing Completed!")
    print("=" * 60)
    print(f"Database initialization completed")
    print(f"{len(users_info)} users created (users.json)")
    print(f"Receiver mailbox cleaned (senders only have user records)")
    print(f"Calendar database cleaned")
    print(f"Emails imported to database")
    print(f"Conference information saved to initial_workspace")
    print(f"Groundtruth metadata saved")
    if args.agent_workspace:
        print(f"initial_workspace copied to agent_workspace")

    # Display email statistics
    if not args.skip_generation:
        metadata = backup_data.get('metadata', {})
        if metadata:
            print(f"\nEmail generation statistics:")
            print(f"   Total emails: {metadata.get('total_emails', 0)}")

            target_info = metadata.get('target_info', {})
            target_confs = target_info.get('conferences', [])
            print(f"   Target conference count: {target_info.get('count', 0)}")
            for conf in target_confs:
                print(f"      - {conf['conference']} ({conf['track']}): {conf['deadline']}")

            noise_info = metadata.get('noise_info', {})
            print(f"   Noise conference count: {noise_info.get('count', 0)}")
            print(f"   Noise conference list: {', '.join(noise_info.get('conferences', []))}")

            difficulty = metadata.get('difficulty', {})
            if difficulty:
                print(f"\nDifficulty configuration:")
                print(f"   Reminder emails: {'enabled' if difficulty.get('enable_reminders') else 'disabled'}")
                print(f"   Deadline extensions: {'enabled' if difficulty.get('enable_extensions') else 'disabled'}")

    print(f"\nDirectory locations:")
    print(f"   Email database: {email_db_dir}")
    print(f"   Calendar database: {calendar_db_dir}")
    print(f"   Backup file: {backup_file}")
    print(f"   initial_workspace: {task_root / 'initial_workspace'}")
    print(f"   groundtruth_workspace: {task_root / 'groundtruth_workspace'}")
    if args.agent_workspace:
        print(f"   agent_workspace: {args.agent_workspace}")
    
    print(f"\nReceiver email account:")
    print(f"   Email: {receiver_email}")
    print(f"   Password: {receiver_password}")
    print(f"   Name: {receiver_name}")

    print(f"\nEnvironment variables:")
    print(f"   EMAIL_DATA_DIR={email_db_dir}")
    print(f"   CALENDAR_DATA_DIR={calendar_db_dir}")

    print(f"\nAgent available information:")
    print(f"   - initial_workspace/conference_info.txt - Target conference hints")
    print(f"   - Email database - Conference emails (including noise and reminders)")
    print(f"   - groundtruth_workspace/conference_metadata.json - Ground truth for evaluation")

    print(f"\nNext steps: Agent needs to:")
    print(f"   1. Check conference_info.txt to understand target conferences")
    print(f"   2. Check emails to get accurate deadlines")
    print(f"   3. Set reminders in Calendar (deadline - 3 hours)")
