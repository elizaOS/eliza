import sys
import os
import tarfile
import shutil
import json
from argparse import ArgumentParser
from pathlib import Path
from gem.utils.filesystem import nfs_safe_rmtree

# Add current directory to sys.path for imports when running as standalone script
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from mcp_convert.mcps.email.database_utils import EmailDatabase
from check_local_email import LocalEmailAttachmentChecker  # type: ignore

# FILE_STRUCTURES will be imported dynamically in main() after parsing --task-root  

def extract_groundtruth_files(groundtruth_workspace: str) -> tuple[str, bool]:
    """Extract groundtruth files from compressed archive to the same directory
    
    Returns:
        tuple: (workspace_path, was_extracted) where was_extracted indicates if extraction occurred
    """
    tar_file_path = os.path.join(groundtruth_workspace, "files.tar.gz")
    
    if not os.path.exists(tar_file_path):
        # If no compressed file exists, assume files are already extracted
        return groundtruth_workspace, False
    
    # Check if files are already extracted
    expected_dir = os.path.join(groundtruth_workspace, "Application_Materials_MaryCastillo_2201210606")
    if os.path.exists(expected_dir):
        print(f"✓ Groundtruth files already extracted in: {groundtruth_workspace}")
        return groundtruth_workspace, False
    
    try:
        with tarfile.open(tar_file_path, 'r:gz') as tar:
            # Try to use filter parameter for Python 3.12+, fall back for older versions
            try:
                tar.extractall(path=groundtruth_workspace, filter='data')
            except TypeError:
                # Fall back to no filter for Python < 3.12
                tar.extractall(path=groundtruth_workspace)
        print(f"✓ Extracted groundtruth files to: {groundtruth_workspace}")
        return groundtruth_workspace, True
    except Exception as e:
        raise Exception(f"Failed to extract groundtruth files: {str(e)}")

def cleanup_extracted_files(groundtruth_workspace: str, was_extracted: bool):
    """Clean up extracted files if they were extracted during this evaluation"""
    if was_extracted:
        expected_dir = os.path.join(groundtruth_workspace, "Application_Materials_MaryCastillo_2201210606")
        if os.path.exists(expected_dir):
            try:
                nfs_safe_rmtree(expected_dir)
                print(f"✓ Cleaned up extracted files from: {groundtruth_workspace}")
            except Exception as e:
                print(f"⚠ Warning: Failed to clean up extracted files from {groundtruth_workspace}: {str(e)}")  

if __name__=="__main__":
    parser = ArgumentParser()
    print("args started")
    parser.add_argument("--agent_workspace", required=False)
    parser.add_argument("--groundtruth_workspace", required=False)
    parser.add_argument("--res_log_file", required=False)
    parser.add_argument("--launch_time", required=False)

    parser.add_argument('--subject', '-s', default='submit_material', help='Email subject keyword')
    parser.add_argument('--task-root', type=str, default=None, help='Task root directory path (if not specified, derived from __file__)')
    args = parser.parse_args()

    # Import FILE_STRUCTURES definition
    # Note: generate_task_config.py is source code, located in env_dir (code directory)
    # Use __file__ to locate env_dir, not task_dir
    env_dir_for_import = Path(__file__).parent.parent
    if str(env_dir_for_import) not in sys.path:
        sys.path.insert(0, str(env_dir_for_import))
    try:
        # Use regular import since env_dir_for_import is in sys.path
        from generate_task_config import PhDApplicationConfigGenerator  # type: ignore
        FILE_STRUCTURES = PhDApplicationConfigGenerator.FILE_STRUCTURES
    except ImportError as e:
        print(f"⚠️ Cannot import FILE_STRUCTURES, will use default validation: {e}")
        FILE_STRUCTURES = {}

    print("\n" + "=" * 60)
    print("🔍 PhD Application Email Task Evaluation")
    print("=" * 60)

    # Extract groundtruth files if needed
    groundtruth_workspace, was_extracted = extract_groundtruth_files(args.groundtruth_workspace)
    
    try:
        # Read task configuration
        if args.task_root:
            task_dir = Path(args.task_root)
        else:
            task_dir = Path(__file__).parent.parent

        # Create temporary directory for attachment processing
        temp_dir = task_dir / "temp_attachments"
        temp_dir.mkdir(parents=True, exist_ok=True)
        print(f"📂 Created temporary directory: {temp_dir}")

        email_config_file = task_dir / "email_config.json"
        task_config_file = task_dir / "task_config_generated.json"
        receiver_config_file = task_dir / "files" / "receiver_config.json"

        if not email_config_file.exists():
            print(f"❌ Email configuration file not found: {email_config_file}")
            exit(1)

        # Read Mary's email configuration (account to view emails)
        with open(email_config_file, 'r', encoding='utf-8') as f:
            email_config = json.load(f)
        mary_email = email_config['email']
        mary_name = email_config['name']

        # Read receiver configuration (admissions committee member, Agent should send email to this person)
        if receiver_config_file.exists():
            with open(receiver_config_file, 'r', encoding='utf-8') as f:
                receiver_config = json.load(f)
            target_receiver_email = receiver_config['email']
            target_receiver_name = receiver_config['name']
            print(f"📬 Target receiver: {target_receiver_name} ({target_receiver_email})")
        else:
            target_receiver_email = None
            print("⚠️  receiver_config.json not found, will check all emails")

        # Read task configuration (to know which positive professors and their file structure requirements)
        positive_structures = {}
        if task_config_file.exists():
            with open(task_config_file, 'r', encoding='utf-8') as f:
                task_config = json.load(f)

            print(f"📝 Task configuration:")
            print(f"   Number of professors: {task_config.get('num_professors', 'N/A')}")
            print(f"   Number of positive replies: {task_config.get('num_positive', 'N/A')}")

            # Extract positive professors and their file structures
            positive_profs = task_config.get('positive_professors', [])
            structure_info = task_config.get('structure_info', {})
            assign_different = task_config.get('assign_different_structures', False)

            print(f"\n✅ Valid file structure options ({len(positive_profs)}):")
            for prof in positive_profs:
                prof_email = prof['email']
                if assign_different and prof_email in structure_info:
                    structure = structure_info[prof_email]['structure_key']
                    structure_name = structure_info[prof_email]['structure_info']['name']
                else:
                    structure = task_config.get('structure', 'standard')
                    structure_name = structure_info.get('default', {}).get('structure_info', {}).get('name', 'Standard Structure')

                # Get structure definition
                structure_def = FILE_STRUCTURES.get(structure, {})

                positive_structures[prof_email] = {
                    'name': prof['full_name'],
                    'structure_key': structure,
                    'structure_name': structure_name,
                    'structure_def': structure_def
                }
                print(f"   • {prof['full_name']}: {structure_name} ({structure})")
        else:
            print("⚠️  task_config_generated.json not found, will use default validation")
        
        print(f"\n📧 Mary's email: {mary_name} ({mary_email})")

        # Determine email database directory
        if args.agent_workspace:
            workspace_parent = Path(args.agent_workspace).parent
            email_db_dir = str(workspace_parent / "local_db" / "emails")
        else:
            email_db_dir = str(Path(__file__).parent.parent / "local_db" / "emails")
        
        print(f"📂 Email database directory: {email_db_dir}")

        if not Path(email_db_dir).exists():
            print(f"❌ Email database directory does not exist: {email_db_dir}")
            exit(1)

        # Initialize EmailDatabase
        email_db = EmailDatabase(data_dir=email_db_dir)

        # Set environment variable
        os.environ['EMAIL_DATA_DIR'] = email_db_dir
        
        print(f"\n🔍 Checking email subject keyword: '{args.subject}'")
        print("=" * 60)

        # Check if Agent needs to send to multiple positive professors or just to admissions team
        assign_different = task_config.get('assign_different_structures', False) if task_config_file.exists() else False

        if assign_different and positive_structures:
            # Mode 1: Different professors have different requirements, need to send emails to each professor separately
            print(f"\n🔍 Check mode: Multiple professors have different requirements, need to send emails separately")
            print(f"   Number of professors to check: {len(positive_structures)}")
            
            all_success = True
            results = {}
            
            for prof_email, prof_info in positive_structures.items():
                print(f"\n{'='*60}")
                print(f"📧 Checking email sent to {prof_info['name']} ({prof_email})")
                print(f"   Required file structure: {prof_info['structure_name']} ({prof_info['structure_key']})")
                
                # Create a checker for each professor
                checker = LocalEmailAttachmentChecker(
                    email_db=email_db,
                    receiver_email=prof_email,
                    groundtruth_workspace=groundtruth_workspace,
                    temp_dir=str(temp_dir)
                )

                # Only allow this professor's file structure
                checker.set_valid_structures({prof_email: prof_info})
                
                success = checker.run(args.subject)
                results[prof_email] = {
                    'success': success,
                    'name': prof_info['name'],
                    'structure': prof_info['structure_name']
                }
                
                if not success:
                    all_success = False
            
            # Output comprehensive results
            print("\n" + "=" * 60)
            print("📊 Comprehensive Evaluation Results")
            print("=" * 60)

            for prof_email, result in results.items():
                status = "✅" if result['success'] else "❌"
                print(f"{status} {result['name']} ({prof_email})")
                print(f"   Required structure: {result['structure']}")

            if all_success:
                print("\n🎉 Test successful!")
                print("=" * 60)
                print(f"✅ Successfully sent emails meeting requirements to all {len(positive_structures)} positive professors")
            else:
                print("\n💥 Test failed!")
                print("=" * 60)
                print("📝 Issues:")
                for prof_email, result in results.items():
                    if not result['success']:
                        print(f"   ❌ Failed to send email meeting requirements to {result['name']} ({prof_email})")
                        print(f"      • Does the email subject contain 'submit_material'?")
                        print(f"      • Does the attachment structure match {result['structure']}?")
                        print(f"      • Are all required files present?")
            
            success = all_success
            
        else:
            # Mode 2: All positive professors have the same requirements, or only send to admissions team
            if target_receiver_email:
                print(f"\n📧 Checking email sent to {target_receiver_name} ({target_receiver_email})")
            else:
                print(f"\n📧 Checking email sent to default receiver")

            # Create local email attachment checker and run
            if target_receiver_email:
                check_email = target_receiver_email
            else:
                # If no receiver_config, check emails received by Mary (backward compatibility)
                check_email = mary_email
            
            checker = LocalEmailAttachmentChecker(
                email_db=email_db,
                receiver_email=check_email,
                groundtruth_workspace=groundtruth_workspace,
                temp_dir=str(temp_dir)
            )
            
            # If there are multiple positive structures, pass them to checker
            if positive_structures:
                checker.set_valid_structures(positive_structures)
            
            success = checker.run(args.subject)  
            
            print("\n" + "=" * 60)
            if success:
                print("🎉 Test successful!")
                print("=" * 60)
                print("✅ Matching email found")
                print("✅ Email sent to correct receiver")
                print("✅ Attachment structure matches a positive professor's requirements")
                print("✅ File content meets requirements")
            else:
                print("💥 Test failed!")
                print("=" * 60)
                print("📝 Common issues:")
                if target_receiver_email:
                    print(f"   • Did Agent send email to {target_receiver_name} ({target_receiver_email})?")
                else:
                    print("   • Did Agent send email to the correct receiver?")
                print("   • Does the email subject contain 'submit_material'?")
                if positive_structures:
                    print(f"   • Does the attachment structure match any of the following professor's requirements?")
                    for prof_email, info in positive_structures.items():
                        print(f"      - {info['name']}: {info['structure_name']}")
                else:
                    print("   • Is the attachment folder structure correct?")
                print("   • Are all required files present?")
        
    finally:
        # Clean up extracted files if they were extracted during this run
        cleanup_extracted_files(groundtruth_workspace, was_extracted)

        # Clean up temp_dir if it exists
        try:
            if 'temp_dir' in locals() and temp_dir.exists():
                import shutil
                shutil.rmtree(temp_dir)
                print(f"🧹 Cleaned up temporary directory: {temp_dir}")
        except Exception as e:
            print(f"⚠️ Failed to clean up temporary directory: {e}")

    exit(0 if success else 1)