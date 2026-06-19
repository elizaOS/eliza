#!/usr/bin/env python3
"""
Preprocessing script - Set up the initial environment for the low-selling product filtering task (using local database)
Supports dynamic difficulty control
"""

import os
import sys
import shutil
import json
import subprocess
from argparse import ArgumentParser
from pathlib import Path
from datetime import datetime

# Add project path
current_dir = Path(__file__).parent
task_dir = current_dir.parent
sys.path.insert(0, str(task_dir))

from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase
from mcp_convert.mcps.email.database_utils import EmailDatabase
from mcp_convert.mcps.woocommerce.init_database import initialize_database as init_woocommerce_db
from mcp_convert.mcps.email.init_database import initialize_database as init_email_db
from gem.utils.filesystem import nfs_safe_rmtree

def clear_database_folders(woocommerce_db_dir: str, email_db_dir: str) -> bool:
    """Clear WooCommerce and Email database folders"""
    print(f"\n🗑️  Clearing database folders...")
    print("=" * 60)

    try:

        woocommerce_path = Path(woocommerce_db_dir)
        email_path = Path(email_db_dir)

        # Clear WooCommerce database folder
        if woocommerce_path.exists():
            print(f"   🛒 Deleting WooCommerce database folder: {woocommerce_path}")
            nfs_safe_rmtree(woocommerce_path)
            print(f"   ✓ WooCommerce folder deleted")
        else:
            print(f"   ℹ️  WooCommerce folder does not exist, skipping deletion")

        # Clear Email database folder
        if email_path.exists():
            print(f"   📧 Deleting Email database folder: {email_path}")
            nfs_safe_rmtree(email_path)
            print(f"   ✓ Email folder deleted")
        else:
            print(f"   ℹ️  Email folder does not exist, skipping deletion")

        print(f"✅ Database folders cleared successfully")
        return True

    except Exception as e:
        print(f"❌ Failed to clear folders: {e}")
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
            print(f"   ℹ️  initial_workspace does not exist, creating empty directory")
            initial_workspace.mkdir(parents=True, exist_ok=True)

        # Ensure agent_workspace exists
        agent_workspace_path.mkdir(parents=True, exist_ok=True)

        # Copy all files
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

        if copied_count > 0:
            print(f"✅ Successfully copied {copied_count} items to agent_workspace")
        else:
            print(f"   ℹ️  initial_workspace is empty, no files to copy")
        return True
    except Exception as e:
        print(f"❌ Copy failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_products_and_subscribers(task_root: Path,
                                     num_low_selling: int = 5,
                                     num_normal_selling: int = 3,
                                     num_subscribers: int = 3,
                                     seed: int = 42) -> bool:
    """
    Generate product and subscriber data

    Args:
        task_root: Task root directory
        num_low_selling: Number of low-selling products
        num_normal_selling: Number of normal-selling products
        num_subscribers: Number of subscribers
        seed: Random seed

    Returns:
        True if successful
    """
    print("\n📝 Step 0: Generating product and subscriber data...")
    print("=" * 60)

    try:
        generator_script = Path(__file__).parent / "generate_products_data.py"

        if not generator_script.exists():
            print(f"❌ Data generation script not found: {generator_script}")
            return False

        # Build command
        cmd = [
            sys.executable,
            str(generator_script),
            "--output-dir", str(task_root),
            "--num-low-selling", str(num_low_selling),
            "--num-normal-selling", str(num_normal_selling),
            "--num-subscribers", str(num_subscribers),
            "--seed", str(seed)
        ]

        print(f"🎲 Generation parameters:")
        print(f"   Low-selling products: {num_low_selling}")
        print(f"   Normal-selling products: {num_normal_selling}")
        print(f"   Subscribers: {num_subscribers}")
        print(f"   Random seed: {seed}")

        # Run generation script
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent)
        )

        # Output generation script output
        if result.stdout:
            print(result.stdout)

        if result.returncode != 0:
            print(f"❌ Data generation failed:")
            if result.stderr:
                print(result.stderr)
            return False

        print("✅ Data generation successful!")
        return True

    except Exception as e:
        print(f"❌ Data generation exception: {e}")
        import traceback
        traceback.print_exc()
        return False


def setup_woocommerce_database(woocommerce_db_dir: str, task_root: Path, use_generated_data: bool = True) -> bool:
    """Set up WooCommerce database"""
    print("\n🛒 Step 1: Initializing WooCommerce database...")
    print("=" * 60)

    try:
        # Create database directory
        Path(woocommerce_db_dir).mkdir(parents=True, exist_ok=True)

        # Initialize database (using init_database.py)
        print(f"   📁 Database directory: {woocommerce_db_dir}")

        # If using generated data, read and insert
        if use_generated_data:
            generated_products_file = task_root / "preprocess" / "generated_products.json"

            if generated_products_file.exists():
                print(f"   📦 Using generated product data: {generated_products_file}")

                # Initialize empty database first (without sample product data)
                init_woocommerce_db(woocommerce_db_dir, verbose=False, include_demo_data=False)

                # Read generated product data
                with open(generated_products_file, 'r', encoding='utf-8') as f:
                    products_data = json.load(f)

                # Get database instance
                db = WooCommerceDatabase(data_dir=woocommerce_db_dir)

                # Batch create products
                print(f"   📤 Inserting {len(products_data)} products into database...")
                for idx, product_data in enumerate(products_data, 1):
                    try:
                        product_id = db.create_product(product_data)
                        if idx % 50 == 0:
                            print(f"      Progress: {idx}/{len(products_data)}")
                    except Exception as e:
                        print(f"      ⚠️  Failed to insert product {product_data.get('name')}: {e}")

                print(f"   ✅ Product data insertion complete")
            else:
                print(f"   ⚠️  Generated product data not found, using default initialization (with sample products)")
                init_woocommerce_db(woocommerce_db_dir, verbose=True, include_demo_data=True)
        else:
            # Use default initialization (with sample products)
            init_woocommerce_db(woocommerce_db_dir, verbose=True, include_demo_data=True)

        # Verify database
        db = WooCommerceDatabase(data_dir=woocommerce_db_dir)
        products = db.list_products()
        orders = db.list_orders()
        customers = db.list_customers()

        print(f"\n✅ WooCommerce database initialization complete!")
        print(f"   Product count: {len(products)}")
        print(f"   Order count: {len(orders)}")
        print(f"   Customer count: {len(customers)}")

        return True

    except Exception as e:
        print(f"❌ WooCommerce database initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def ensure_users_exist(db: EmailDatabase, users_info: list) -> bool:
    """Ensure users exist in the database"""
    print(f"\n👥 Ensuring {len(users_info)} users exist in database...")

    try:
        # Read or initialize users.json
        if not db.users:
            db.users = {}

        for user_info in users_info:
            email = user_info['email']
            password = user_info.get('password', 'default_password')
            name = user_info.get('name', email.split('@')[0])

            # If user does not exist, add
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


def clear_email_database(db: EmailDatabase, user_emails: list) -> bool:
    """Clear mailbox data for specified users"""
    print(f"\n🗑️  Clearing database for {len(user_emails)} mailboxes...")

    try:
        for user_email in user_emails:
            # Get user data directory
            user_dir = db._get_user_data_dir(user_email)

            # If user data does not exist, create empty
            if not Path(user_dir).exists():
                Path(user_dir).mkdir(parents=True, exist_ok=True)
                # Create empty email, folder, and draft files
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
        print(f"   ❌ Clearing failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def setup_email_database(email_db_dir: str, task_root: Path, admin_email: str, admin_password: str, admin_name: str) -> bool:
    """Set up Email database"""
    print("\n📧 Step 2: Initializing Email database...")
    print("=" * 60)

    try:
        # Create database directory
        Path(email_db_dir).mkdir(parents=True, exist_ok=True)

        # Initialize database
        db = EmailDatabase(data_dir=email_db_dir)

        # Read subscriber.json
        subscriber_file = task_root / "initial_workspace" / "subscriber.json"
        if not subscriber_file.exists():
            print(f"   ⚠️  subscriber.json not found, only creating admin user")
            subscribers = []
        else:
            with open(subscriber_file, 'r', encoding='utf-8') as f:
                subscriber_config = json.load(f)
            subscribers = subscriber_config.get('subscriber_list', [])
            print(f"   📋 Found {len(subscribers)} subscribers")

        # Prepare all user info (admin + subscribers)
        users_info = [
            {"email": admin_email, "password": admin_password, "name": admin_name}
        ]

        for subscriber in subscribers:
            users_info.append({
                "email": subscriber['email'],
                "password": "subscriber123",  # Default password
                "name": subscriber['name']
            })

        # Create all users
        if not ensure_users_exist(db, users_info):
            print("❌ User creation failed")
            return False

        # Clear/create mailbox folders for all users
        all_emails = [u['email'] for u in users_info]
        if not clear_email_database(db, all_emails):
            print("⚠️  Mailbox folder creation not fully successful, but continuing")

        print(f"\n✅ Email database initialization complete!")
        print(f"   Admin account: {admin_email}")
        print(f"   Subscriber accounts: {len(subscribers)}")
        for subscriber in subscribers:
            print(f"      • {subscriber['name']} ({subscriber['email']})")

        return True

    except Exception as e:
        print(f"❌ Email database initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def save_admin_credentials(task_root: Path, email: str, password: str) -> bool:
    """Save admin account info to initial_workspace"""
    print(f"\n💾 Step 3: Saving admin account info...")
    print("=" * 60)

    try:
        initial_workspace = task_root / "initial_workspace"
        initial_workspace.mkdir(parents=True, exist_ok=True)

        credentials_file = initial_workspace / "admin_credentials.txt"

        with open(credentials_file, 'w', encoding='utf-8') as f:
            f.write(f"WooCommerce & Email Admin Account\n")
            f.write(f"==================================\n\n")
            f.write(f"Email: {email}\n")
            f.write(f"Password: {password}\n\n")
            f.write(f"This account has access to both WooCommerce and Email systems.\n")

        print(f"   ✓ Account info saved to: {credentials_file}")
        return True

    except Exception as e:
        print(f"   ❌ Save failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    parser = ArgumentParser(description="Preprocessing script - Set up the initial environment for the low-selling product filtering task")
    parser.add_argument("--agent_workspace", required=False, help="Agent workspace path")
    parser.add_argument("--launch_time", required=False, help="Launch time")

    # Data generation control
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip data generation, use existing files")
    parser.add_argument("--num-low-selling", type=int, default=3,
                       help="Number of low-selling products (default: 5)")
    parser.add_argument("--num-normal-selling", type=int, default=5,
                       help="Number of normal-selling products (default: 3)")
    parser.add_argument("--num-subscribers", type=int, default=3,
                       help="Number of subscribers (default: 3)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")

    # Difficulty presets
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert", "extreme", "insane"],
                       help="Difficulty preset (optional, will override other parameters)")

    args = parser.parse_args()

    # Apply difficulty preset
    if args.difficulty:
        print(f"🎲 Using difficulty preset: {args.difficulty}")

        if args.difficulty == "easy":
            args.num_low_selling = 3
            args.num_normal_selling = 2
            args.num_subscribers = 2
        elif args.difficulty == "medium":
            args.num_low_selling = 5
            args.num_normal_selling = 5
            args.num_subscribers = 3
        elif args.difficulty == "hard":
            args.num_low_selling = 10
            args.num_normal_selling = 15
            args.num_subscribers = 5
        elif args.difficulty == "expert":
            args.num_low_selling = 20
            args.num_normal_selling = 30
            args.num_subscribers = 10
        elif args.difficulty == "extreme":
            args.num_low_selling = 50
            args.num_normal_selling = 100
            args.num_subscribers = 25
        elif args.difficulty == "insane":
            args.num_low_selling = 100
            args.num_normal_selling = 200
            args.num_subscribers = 50
    else:
        print(f"🎲 Using custom parameters")

    print("\n" + "=" * 60)
    print("🎯 Low-Selling Product Filtering Task - Preprocessing (Local Database Version)")
    print("=" * 60)
    print("Using local database (WooCommerce + Email)")

    # Get task root directory
    # When agent_workspace is provided, task_root is its parent directory
    # Otherwise, assume we're in the code directory structure
    if args.agent_workspace:
        task_root = Path(args.agent_workspace).parent
    else:
        task_root = Path(__file__).parent.parent

    # Admin account configuration
    admin_email = "admin@woocommerce.local"
    admin_password = "admin123"
    admin_name = "WooCommerce Admin"

    # Determine database directories
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        woocommerce_db_dir = str(workspace_parent / "local_db" / "woocommerce")
        email_db_dir = str(workspace_parent / "local_db" / "emails")
    else:
        woocommerce_db_dir = str(Path(__file__).parent.parent / "local_db" / "woocommerce")
        email_db_dir = str(Path(__file__).parent.parent / "local_db" / "emails")

    print(f"\n📂 Task root directory: {task_root}")
    print(f"📂 Database directories:")
    print(f"   WooCommerce: {woocommerce_db_dir}")
    print(f"   Email: {email_db_dir}")

    # Step 0: Generate product and subscriber data (optional)
    if not args.skip_generation:
        print("\n" + "=" * 60)
        print("STEP 0: Generate product and subscriber data")
        print("=" * 60)

        if not generate_products_and_subscribers(
            task_root=task_root,
            num_low_selling=args.num_low_selling,
            num_normal_selling=args.num_normal_selling,
            num_subscribers=args.num_subscribers,
            seed=args.seed
        ):
            print("❌ Data generation failed!")
            sys.exit(1)
    else:
        print("\n" + "=" * 60)
        print("STEP 0: Skip data generation")
        print("=" * 60)
        print("Using existing data files")

    # Clear database folders
    if not clear_database_folders(woocommerce_db_dir, email_db_dir):
        print("⚠️  Failed to clear database folders, but continuing")

    # Step 1: Set up WooCommerce database
    if not setup_woocommerce_database(woocommerce_db_dir, task_root, use_generated_data=not args.skip_generation):
        print("❌ WooCommerce database setup failed")
        sys.exit(1)

    # Step 2: Set up Email database (including subscribers)
    if not setup_email_database(email_db_dir, task_root, admin_email, admin_password, admin_name):
        print("❌ Email database setup failed")
        sys.exit(1)

    # Step 3: Save admin account info
    if not save_admin_credentials(task_root, admin_email, admin_password):
        print("⚠️  Failed to save admin account info, but continuing")

    # Set environment variables
    os.environ['WOOCOMMERCE_DATA_DIR'] = woocommerce_db_dir
    os.environ['EMAIL_DATA_DIR'] = email_db_dir

    # Write environment variable file
    if args.agent_workspace:
        env_file = Path(args.agent_workspace).parent / "local_db" / ".env"
    else:
        env_file = Path(woocommerce_db_dir).parent / ".env"

    try:
        env_file.parent.mkdir(parents=True, exist_ok=True)
        with open(env_file, 'w') as f:
            f.write(f"# WooCommerce & Email Database Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export WOOCOMMERCE_DATA_DIR={woocommerce_db_dir}\n")
            f.write(f"export EMAIL_DATA_DIR={email_db_dir}\n")
        print(f"\n📄 Environment variable file created: {env_file}")
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

    # Read subscriber info for final output
    subscriber_file = task_root / "initial_workspace" / "subscriber.json"
    subscribers = []
    if subscriber_file.exists():
        with open(subscriber_file, 'r', encoding='utf-8') as f:
            subscriber_config = json.load(f)
        subscribers = subscriber_config.get('subscriber_list', [])

    print("\n" + "=" * 60)
    print("🎉 Low-selling product filtering task environment preprocessing complete!")
    print("=" * 60)

    if not args.skip_generation:
        print(f"✅ Data generation complete")
        print(f"   • Low-selling products: {args.num_low_selling}")
        print(f"   • Normal-selling products: {args.num_normal_selling}")
        print(f"   • Subscribers: {args.num_subscribers}")

    print(f"✅ WooCommerce database initialized")
    print(f"✅ Email database initialized")
    print(f"✅ Admin account created and saved")
    print(f"✅ {len(subscribers)} subscriber accounts created")
    if args.agent_workspace:
        print(f"✅ initial_workspace copied to agent_workspace")

    print(f"\n📂 Directory locations:")
    print(f"   WooCommerce database: {woocommerce_db_dir}")
    print(f"   Email database: {email_db_dir}")
    print(f"   initial_workspace: {task_root / 'initial_workspace'}")
    if args.agent_workspace:
        print(f"   agent_workspace: {args.agent_workspace}")

    print(f"\n📌 Environment variables:")
    print(f"   WOOCOMMERCE_DATA_DIR={woocommerce_db_dir}")
    print(f"   EMAIL_DATA_DIR={email_db_dir}")

    print(f"\n👤 Admin account:")
    print(f"   Email: {admin_email}")
    print(f"   Password: {admin_password}")
    print(f"   Name: {admin_name}")

    print(f"\n👥 Subscriber accounts ({len(subscribers)}):")
    for subscriber in subscribers:
        print(f"   • {subscriber['name']} ({subscriber['email']}) - Password: subscriber123")

    print(f"\n💡 Next step: Agent can use the following MCP servers:")
    print(f"   • woocommerce-simplified - View products, orders, sales data")
    print(f"   • emails-simplified - Send notification emails")
    print(f"\n📝 Task hints:")
    print(f"   • Analyze sales data, find low-selling products (in stock >90 days, 30-day sales <10)")
    print(f"   • Move low-selling products to Outlet/Clearance category")
    print(f"   • Send promotional notification emails to {len(subscribers)} subscribers via Email")

    # Display difficulty info
    if args.difficulty:
        print(f"\n🎮 Difficulty setting: {args.difficulty.upper()}")

    print(f"\n📊 Database statistics:")
    # Verify and display database statistics
    try:
        wc_db = WooCommerceDatabase(data_dir=woocommerce_db_dir)
        all_products = list(wc_db.products.values())

        # Calculate low-selling products
        from datetime import datetime
        current_date = datetime.now()
        low_selling_count = 0

        for product in all_products:
            date_created_str = product.get('date_created', '')
            if not date_created_str:
                continue

            date_created = datetime.fromisoformat(date_created_str.replace('Z', '+00:00'))
            days_in_stock = (current_date - date_created.replace(tzinfo=None)).days

            sales_30_days = 0
            for meta in product.get('meta_data', []):
                if meta.get('key') == 'sales_last_30_days':
                    sales_30_days = int(meta.get('value', 0))
                    break

            if days_in_stock > 90 and sales_30_days < 10:
                low_selling_count += 1

        print(f"   Total products: {len(all_products)}")
        print(f"   Low-selling products: {low_selling_count} (in stock >90 days, 30-day sales <10)")
        print(f"   Normal-selling products: {len(all_products) - low_selling_count}")

    except Exception as e:
        print(f"   ⚠️  Unable to read database statistics: {e}")

    sys.exit(0)
