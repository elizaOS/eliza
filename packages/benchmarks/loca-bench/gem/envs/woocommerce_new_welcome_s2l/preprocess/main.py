#!/usr/bin/env python3
"""
WooCommerce New Welcome Task - Preprocess Setup
Set up initial working environment: clear mailbox, set up WooCommerce order data, prepare BigQuery environment
Uses local database (WooCommerce + Email + Google Cloud)
"""
import os
import sys
import json
import time
import shutil
from argparse import ArgumentParser
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List

# Add parent directory to import token configuration
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
project_root = os.path.dirname(os.path.dirname(os.path.dirname(task_dir)))
sys.path.insert(0, task_dir)  # For token_key_session
sys.path.insert(0, project_root)  # For utils
from gem.utils.filesystem import nfs_safe_rmtree
# Add mcp_convert path to import database tools
from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase
from mcp_convert.mcps.woocommerce.order_generator import create_new_welcome_orders
from mcp_convert.mcps.woocommerce.init_database import initialize_database as init_woocommerce_db
from mcp_convert.mcps.email.database_utils import EmailDatabase
from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase


def clear_email_database(db: EmailDatabase, user_email: str) -> bool:
    """Clear mailbox data for specified user"""
    print(f"🗑️  Clearing mailbox database: {user_email}...")
    
    try:
        # Get user data directory
        user_dir = db._get_user_data_dir(user_email)

        # If user data doesn't exist, create empty
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
            print(f"   ✓ Cleanup completed: {user_email}")

        return True
    except Exception as e:
        print(f"   ❌ Cleanup failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def ensure_users_exist(db: EmailDatabase, users_info: List[Dict]) -> bool:
    """Ensure users exist in the database"""
    print(f"👥 Ensuring {len(users_info)} users exist in database...")
    
    try:
        # Read or initialize users.json
        if not db.users:
            db.users = {}

        for user_info in users_info:
            email = user_info['email']
            password = user_info.get('password', 'default_password')
            name = user_info.get('name', email.split('@')[0])

            # If user doesn't exist, add
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


def clear_mailbox(email_db: EmailDatabase, admin_email: str) -> Dict:
    """
    Clear mailbox - Clear mailbox using local database

    Returns:
        Cleanup result dictionary
    """
    print("📧 Starting mailbox cleanup...")

    try:
        # Clear admin mailbox
        if clear_email_database(email_db, admin_email):
            return {
                "success": True,
                "cleared_folders": ["INBOX", "Sent", "Trash"],
                "timestamp": datetime.now().isoformat()
            }
        else:
            return {
                "success": False,
                "error": "Mailbox cleanup failed",
                "timestamp": datetime.now().isoformat()
            }

    except Exception as e:
        error_result = {
            "success": False,
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }
        print(f"❌ Error during mailbox cleanup: {e}")
        return error_result


def setup_woocommerce_orders(
    woocommerce_db_dir: str,
    task_root: Path,
    total_orders: int = 30,
    first_time_customer_count: int = 12,
    noise_orders_outside_window: int = 0,
    noise_orders_incomplete: int = 0,
    seed: int = None
) -> Dict:
    """
    Set up WooCommerce order data: clear existing orders and add new first-time purchase orders

    Args:
        woocommerce_db_dir: WooCommerce database directory
        task_root: Task root directory
        total_orders: Total number of orders
        first_time_customer_count: Number of first-time customers
        noise_orders_outside_window: Number of noise orders outside 7-day window
        noise_orders_incomplete: Number of incomplete noise orders
        seed: Random seed

    Returns:
        Setup result dictionary
    """
    print("🛍️ Setting up WooCommerce order data...")
    print(f"   Total orders: {total_orders}")
    print(f"   First-time customers: {first_time_customer_count}")
    print(f"   Noise orders (outside 7 days): {noise_orders_outside_window}")
    print(f"   Noise orders (incomplete): {noise_orders_incomplete}")
    print(f"   Random seed: {seed}")

    try:
        # Delayed import of WooCommerce module
        try:
            from mcps.woocommerce.order_generator import create_new_welcome_orders
        except ImportError as e:
            print(f"❌ Cannot import WooCommerce module: {e}")
            return {
                "success": False,
                "error": f"Cannot import WooCommerce module: {e}",
                "timestamp": datetime.now().isoformat()
            }

        # Step 1: Clear existing database
        print("🗑️ Clearing existing WooCommerce database...")
        if Path(woocommerce_db_dir).exists():
            nfs_safe_rmtree(woocommerce_db_dir)
            print(f"   ✓ Deleted old database")

        # Create database directory
        Path(woocommerce_db_dir).mkdir(parents=True, exist_ok=True)

        # Step 2: Generate new order data
        print("📦 Generating new order data...")
        all_orders, first_time_orders = create_new_welcome_orders(
            seed=seed,
            total_orders=total_orders,
            first_time_customer_count=first_time_customer_count,
            noise_orders_outside_window=noise_orders_outside_window,
            noise_orders_incomplete=noise_orders_incomplete
        )

        # Step 3: Initialize database and insert orders
        print("📤 Initializing database and inserting orders...")
        init_woocommerce_db(woocommerce_db_dir, verbose=False, include_demo_data=False)

        # Get database instance
        db = WooCommerceDatabase(data_dir=woocommerce_db_dir)

        # Insert customers and orders while collecting customer info
        successful_orders = 0
        failed_orders = 0
        customer_info = {}  # {email: {name, first_name, last_name}}
        
        for order in all_orders:
            try:
                # Extract customer info from order (supports two formats)
                # Format 1: customer_email + customer_name (returned from create_new_welcome_orders)
                customer_email = order.get('customer_email', '') or order.get('billing', {}).get('email', '')
                customer_name = order.get('customer_name', '')

                if customer_email:
                    # Collect customer info
                    if customer_email not in customer_info:
                        # Separate first_name and last_name from customer_name
                        if customer_name:
                            name_parts = customer_name.split(' ', 1)
                            first_name = name_parts[0] if len(name_parts) > 0 else ''
                            last_name = name_parts[1] if len(name_parts) > 1 else ''
                        else:
                            first_name = order.get('billing', {}).get('first_name', '')
                            last_name = order.get('billing', {}).get('last_name', '')
                            customer_name = f"{first_name} {last_name}".strip()
                        
                        customer_info[customer_email] = {
                            'email': customer_email,
                            'first_name': first_name,
                            'last_name': last_name,
                            'name': customer_name or customer_email.split('@')[0]
                        }
                    
                    # Check if customer exists
                    existing_customers = [c for c in db.customers.values()
                                        if c.get('email') == customer_email]

                    if not existing_customers:
                        # Get customer info for creation
                        cust_info = customer_info[customer_email]
                        # Create new customer
                        customer_data = {
                            'email': customer_email,
                            'first_name': cust_info['first_name'],
                            'last_name': cust_info['last_name'],
                            'billing': order.get('billing', {}),
                            'shipping': order.get('shipping', {})
                        }
                        db.create_customer(customer_data)
                
                # Create order
                db.create_order(order)
                successful_orders += 1
            except Exception as e:
                print(f"      ⚠️  Failed to insert order: {e}")
                failed_orders += 1

        print(f"📊 Order setup results:")
        print(f"   New orders generated: {len(all_orders)}")
        print(f"   Successfully inserted: {successful_orders}")
        print(f"   Failed insertions: {failed_orders}")
        print(f"   First-time purchase customers: {len(first_time_orders)}")
        print(f"   Unique customers: {len(customer_info)}")

        # Create preprocess directory (if it doesn't exist)
        preprocess_dir = task_root / "preprocess"
        preprocess_dir.mkdir(parents=True, exist_ok=True)

        # Save order data to file for evaluation use
        orders_file = task_root / "preprocess" / "generated_orders.json"
        with open(orders_file, 'w', encoding='utf-8') as f:
            json.dump({
                "all_orders": all_orders,
                "first_time_orders": first_time_orders
            }, f, ensure_ascii=False, indent=2)

        print(f"📄 Order data saved to: {orders_file}")

        return {
            "success": failed_orders == 0,
            "generated_orders": len(all_orders),
            "successful_uploads": successful_orders,
            "failed_uploads": failed_orders,
            "first_time_customers": len(first_time_orders),
            "orders_file": str(orders_file),
            "customer_info": list(customer_info.values())  # Return customer info list
        }

    except Exception as e:
        error_msg = f"Error during WooCommerce order setup: {e}"
        print(f"❌ {error_msg}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": error_msg
        }


def main():
    """Main preprocessing function"""

    parser = ArgumentParser(description="Preprocess script - Set up the initial environment for the WooCommerce new welcome task")
    parser.add_argument("--agent_workspace", required=False, help="Agent workspace path")
    parser.add_argument("--launch_time", required=False, help="Launch time")

    # Data generation control parameters
    parser.add_argument("--total-orders", type=int, default=20,
                       help="Total number of orders (default: 30)")
    parser.add_argument("--first-time-customers", type=int, default=10,
                       help="Number of first-time customers (default: 12)")
    parser.add_argument("--noise-outside-window", type=int, default=0,
                       help="Number of noise orders outside 7-day window (default: 0)")
    parser.add_argument("--noise-incomplete", type=int, default=0,
                       help="Number of incomplete noise orders (default: 0)")
    parser.add_argument("--seed", type=int, default=None,
                       help="Random seed (default: use current time)")

    # Difficulty presets
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert", "extreme"],
                       help="Difficulty preset (optional, will override other parameters)")
    
    args = parser.parse_args()
    
    # Apply difficulty presets
    if args.difficulty:
        print(f"🎲 Using difficulty preset: {args.difficulty.upper()}")

        if args.difficulty == "easy":
            # Easy: few orders, high first-time customer ratio, no noise
            args.total_orders = 20
            args.first_time_customers = 15
            args.noise_outside_window = 0
            args.noise_incomplete = 0
        elif args.difficulty == "medium":
            # Medium: moderate orders, moderate first-time customer ratio, light noise
            args.total_orders = 30
            args.first_time_customers = 12
            args.noise_outside_window = 3
            args.noise_incomplete = 2
        elif args.difficulty == "hard":
            # Hard: more orders, lower first-time customer ratio, moderate noise
            args.total_orders = 50
            args.first_time_customers = 15
            args.noise_outside_window = 8
            args.noise_incomplete = 5
        elif args.difficulty == "expert":
            # Expert: many orders, even lower first-time customer ratio, more noise
            args.total_orders = 80
            args.first_time_customers = 20
            args.noise_outside_window = 15
            args.noise_incomplete = 10
        elif args.difficulty == "extreme":
            # Extreme: massive orders, very low first-time customer ratio, heavy noise
            args.total_orders = 120
            args.first_time_customers = 25
            args.noise_outside_window = 25
            args.noise_incomplete = 15
    else:
        print(f"🎲 Using custom parameters")

    print(f"\n📊 Data generation parameters:")
    print(f"   Total orders: {args.total_orders}")
    print(f"   First-time customers: {args.first_time_customers}")
    print(f"   Noise (outside 7 days): {args.noise_outside_window}")
    print(f"   Noise (incomplete): {args.noise_incomplete}")
    print(f"   Random seed: {args.seed or '(auto)'}")

    print("\n" + "=" * 80)
    print("WooCommerce New Welcome Task - Preprocessing")
    print("=" * 80)
    print("Using local database (WooCommerce + Email + Google Cloud)")

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
        gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
    else:
        woocommerce_db_dir = str(Path(__file__).parent.parent / "local_db" / "woocommerce")
        email_db_dir = str(Path(__file__).parent.parent / "local_db" / "emails")
        gcloud_db_dir = str(Path(__file__).parent.parent / "local_db" / "google_cloud")
    
    print(f"\n📂 Database directories:")
    print(f"   WooCommerce: {woocommerce_db_dir}")
    print(f"   Email: {email_db_dir}")
    print(f"   Google Cloud: {gcloud_db_dir}")

    results = []

    try:
        # Step 1: Initialize Email database and clear mailbox
        print("\n" + "="*60)
        print("Step 1: Setup Email Database and Clear Mailbox")
        print("="*60)

        # Clear and create email database directory
        if Path(email_db_dir).exists():
            nfs_safe_rmtree(email_db_dir)
        Path(email_db_dir).mkdir(parents=True, exist_ok=True)
        
        # Initialize EmailDatabase
        email_db = EmailDatabase(data_dir=email_db_dir)

        # Create admin user
        users_info = [
            {"email": admin_email, "password": admin_password, "name": admin_name}
        ]
        if not ensure_users_exist(email_db, users_info):
            print("❌ User creation failed")
            results.append(("Email Setup", False, {"error": "User creation failed"}))
        else:
            mailbox_result = clear_mailbox(email_db, admin_email)
            results.append(("Mailbox Cleanup", mailbox_result["success"], mailbox_result))

            if mailbox_result["success"]:
                print("✅ Mailbox cleanup successful")
            else:
                print("⚠️ Mailbox cleanup partially failed, but continuing with subsequent operations...")

        # Step 2: Set up WooCommerce orders
        print("\n" + "="*60)
        print("Step 2: Setup WooCommerce Orders")
        print("="*60)

        woocommerce_result = setup_woocommerce_orders(
            woocommerce_db_dir=woocommerce_db_dir,
            task_root=task_root,
            total_orders=args.total_orders,
            first_time_customer_count=args.first_time_customers,
            noise_orders_outside_window=args.noise_outside_window,
            noise_orders_incomplete=args.noise_incomplete,
            seed=args.seed
        )
        results.append(("WooCommerce Setup", woocommerce_result["success"], woocommerce_result))

        if woocommerce_result["success"]:
            print("✅ WooCommerce order setup successful")
        else:
            print("❌ WooCommerce order setup failed")

        # Step 2b: Create Email user folders for all WooCommerce customers
        print("\n" + "="*60)
        print("Step 2b: Create Email Folders for WooCommerce Customers")
        print("="*60)

        if "customer_info" in woocommerce_result and woocommerce_result["customer_info"]:
            customer_list = woocommerce_result["customer_info"]
            print(f"📧 Creating mailbox user folders for {len(customer_list)} customers...")

            # Prepare user info (add default password)
            customer_users = []
            for customer in customer_list:
                customer_users.append({
                    "email": customer['email'],
                    "password": "customer123",  # Default customer password
                    "name": customer['name'] if customer['name'] else customer['email'].split('@')[0]
                })

            # Ensure these users exist
            if ensure_users_exist(email_db, customer_users):
                # Create mailbox folders for each customer
                customer_email_success = 0
                customer_email_failed = 0
                
                for customer in customer_users:
                    if clear_email_database(email_db, customer['email']):
                        customer_email_success += 1
                    else:
                        customer_email_failed += 1
                
                email_setup_success = customer_email_failed == 0
                results.append(("Customer Email Setup", email_setup_success, {
                    "total_customers": len(customer_users),
                    "successful": customer_email_success,
                    "failed": customer_email_failed
                }))
                
                if email_setup_success:
                    print(f"✅ Successfully created mailbox folders for {customer_email_success} customers")
                else:
                    print(f"⚠️ Partial customer mailbox creation failed: {customer_email_success} succeeded, {customer_email_failed} failed")
            else:
                results.append(("Customer Email Setup", False, {"error": "User creation failed"}))
                print("❌ Customer user creation failed")
        else:
            print("⚠️ No customer information, skipping mailbox folder creation")
            results.append(("Customer Email Setup", True, {"message": "No customer information"}))

        # Step 3: Setup BigQuery environment (using local GoogleCloud database)
        print("\n" + "="*60)
        print("Step 3: Setup BigQuery Environment")
        print("="*60)

        # Clear and create Google Cloud database directory
        if Path(gcloud_db_dir).exists():
            nfs_safe_rmtree(gcloud_db_dir)
        Path(gcloud_db_dir).mkdir(parents=True, exist_ok=True)

        # Initialize GoogleCloudDatabase
        gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)
        project_id = "local-project"

        # Copy customers_data.json to task_root/preprocess directory
        source_json_path = Path(current_dir) / "customers_data.json"
        dest_json_path = task_root / "preprocess" / "customers_data.json"

        if source_json_path.exists():
            print(f"📋 Copying customer data file to task directory...")
            shutil.copy2(source_json_path, dest_json_path)
            print(f"   Source file: {source_json_path}")
            print(f"   Destination file: {dest_json_path}")
            print(f"✅ Customer data file copied successfully")
        else:
            print(f"⚠️  Source customer data file does not exist: {source_json_path}")

        # Read customer data (only insert historical customers, not first-time customers)
        # First-time customers should be synced to BigQuery by the Agent during task execution
        json_path = dest_json_path
        if json_path.exists():
            json_data = read_json_data(str(json_path))

            try:
                dataset_id = setup_bigquery_resources_local(gcloud_db, project_id, json_data)
                results.append(("BigQuery Setup", True, {"dataset_id": dataset_id}))
                print("✅ BigQuery environment setup successful")
            except Exception as e:
                results.append(("BigQuery Setup", False, {"error": str(e)}))
                print(f"❌ BigQuery setup failed: {e}")
        else:
            results.append(("BigQuery Setup", False, {"error": "Customer data file does not exist"}))
            print("❌ Customer data file does not exist")

        # Set environment variables
        os.environ['WOOCOMMERCE_DATA_DIR'] = woocommerce_db_dir
        os.environ['EMAIL_DATA_DIR'] = email_db_dir
        os.environ['GOOGLE_CLOUD_DATA_DIR'] = gcloud_db_dir

        # Summarize results
        print("\n" + "="*80)
        print("PREPROCESSING SUMMARY")
        print("="*80)

        success_count = sum(1 for _, success, _ in results if success)
        total_count = len(results)

        for step_name, success, details in results:
            status = "✅ PASSED" if success else "❌ FAILED"
            print(f"{step_name}: {status}")
            if not success and "error" in details:
                print(f"  Error: {details['error']}")

        overall_success = success_count == total_count
        print(f"\nOverall: {success_count}/{total_count} steps completed successfully")

        if overall_success:
            print("\n🎉 All preprocessing steps completed! Task environment is ready")
            print(f"\n📂 Database locations:")
            print(f"   WooCommerce: {woocommerce_db_dir}")
            print(f"   Email: {email_db_dir}")
            print(f"   Google Cloud: {gcloud_db_dir}")
            print(f"\n👤 Admin account:")
            print(f"   Email: {admin_email}")
            print(f"   Password: {admin_password}")
            return True
        else:
            print("\n⚠️ Preprocessing partially completed, please check failed steps")
            return False

    except Exception as e:
        print(f"❌ Preprocessing failed: {e}")
        import traceback
        traceback.print_exc()
        return False


# Below are BigQuery-related functions (using local database)

import logging

# Enable verbose logging for debugging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)


def read_json_data(json_path: str):
    """Read customer data from JSON file"""
    print(f"📖 Reading JSON data file: {json_path}")

    if not Path(json_path).exists():
        print(f"❌ JSON data file does not exist: {json_path}")
        return []

    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            customers = json.load(f)

        # Ensure data format is correct
        processed_customers = []
        for customer in customers:
            processed_customer = {
                'id': customer.get('id'),
                'woocommerce_id': customer.get('woocommerce_id'),
                'email': customer.get('email'),
                'first_name': customer.get('first_name'),
                'last_name': customer.get('last_name'),
                'phone': customer.get('phone', ''),
                'date_created': customer.get('date_created'),
                'first_order_date': customer.get('first_order_date'),
                'welcome_email_sent': customer.get('welcome_email_sent', False),
                'welcome_email_date': customer.get('welcome_email_date'),
                'sync_date': customer.get('sync_date'),
                'metadata': customer.get('metadata', '{}')
            }
            processed_customers.append(processed_customer)

        print(f"✅ Successfully read {len(processed_customers)} customer records")
        return processed_customers

    except (json.JSONDecodeError, IOError) as e:
        print(f"❌ Error reading JSON data file: {e}")
        return []


def setup_bigquery_resources_local(gcloud_db: GoogleCloudDatabase, project_id: str, json_data: list) -> str:
    """
    Setup BigQuery dataset and tables for WooCommerce CRM using local database
    
    Args:
        gcloud_db: GoogleCloudDatabase instance
        project_id: Project ID
        json_data: Customer data to insert
        
    Returns:
        Dataset ID
    """
    print("=" * 60)
    print("🛍️ Starting BigQuery WooCommerce CRM resource setup (local database)")
    print("=" * 60)

    dataset_id = "woocommerce_crm"

    try:
        # Check if dataset exists, delete if it does
        existing_dataset = gcloud_db.get_bigquery_dataset(project_id, dataset_id)
        if existing_dataset:
            print(f"ℹ️  Found existing dataset '{dataset_id}', deleting...")
            # Delete all tables
            tables = gcloud_db.list_bigquery_tables(project_id, dataset_id)
            for table in tables:
                gcloud_db.delete_bigquery_table(project_id, dataset_id, table['tableId'])
            # Delete dataset
            gcloud_db.delete_bigquery_dataset(project_id, dataset_id)
            print(f"✅ Existing dataset deleted")

        # Create new dataset
        print(f"📦 Creating dataset '{dataset_id}'...")
        dataset_info = {
            "location": "US",
            "description": "WooCommerce CRM dataset for customer management and welcome emails",
            "labels": {}
        }
        gcloud_db.create_bigquery_dataset(project_id, dataset_id, dataset_info)
        print(f"✅ Dataset '{dataset_id}' created successfully")

        # Create customers table
        table_name = "customers"
        print(f"🗂️  Creating table '{table_name}'...")
        schema = [
            {"name": "id", "type": "INTEGER", "mode": "REQUIRED"},
            {"name": "woocommerce_id", "type": "INTEGER", "mode": "REQUIRED"},
            {"name": "email", "type": "STRING", "mode": "REQUIRED"},
            {"name": "first_name", "type": "STRING", "mode": "NULLABLE"},
            {"name": "last_name", "type": "STRING", "mode": "NULLABLE"},
            {"name": "phone", "type": "STRING", "mode": "NULLABLE"},
            {"name": "date_created", "type": "TIMESTAMP", "mode": "NULLABLE"},
            {"name": "first_order_date", "type": "TIMESTAMP", "mode": "NULLABLE"},
            {"name": "welcome_email_sent", "type": "BOOLEAN", "mode": "NULLABLE"},
            {"name": "welcome_email_date", "type": "TIMESTAMP", "mode": "NULLABLE"},
            {"name": "sync_date", "type": "TIMESTAMP", "mode": "NULLABLE"},
            {"name": "metadata", "type": "STRING", "mode": "NULLABLE"},
        ]
        
        table_info = {
            "schema": schema,
            "description": "WooCommerce customer data with welcome email tracking"
        }
        
        gcloud_db.create_bigquery_table(project_id, dataset_id, table_name, table_info)
        print(f"✅ Table '{table_name}' created successfully")

        # Insert data
        if json_data:
            print(f"💾 Inserting {len(json_data)} customer records...")

            # Convert data format
            rows = []
            for customer in json_data:
                # Convert timestamp format
                def convert_timestamp(timestamp_str):
                    if not timestamp_str:
                        return None
                    try:
                        if 'T' in timestamp_str:
                            return datetime.fromisoformat(timestamp_str.replace('Z', '+00:00')).isoformat()
                        else:
                            return datetime.strptime(timestamp_str, '%Y-%m-%d %H:%M:%S').isoformat()
                    except (ValueError, AttributeError):
                        return None
                
                row = {
                    "id": customer['id'],
                    "woocommerce_id": customer['woocommerce_id'],
                    "email": customer['email'],
                    "first_name": customer['first_name'],
                    "last_name": customer['last_name'],
                    "phone": customer['phone'],
                    "date_created": convert_timestamp(customer['date_created']),
                    "first_order_date": convert_timestamp(customer['first_order_date']),
                    "welcome_email_sent": customer['welcome_email_sent'],
                    "welcome_email_date": convert_timestamp(customer['welcome_email_date']),
                    "sync_date": convert_timestamp(customer['sync_date']),
                    "metadata": customer['metadata']
                }
                rows.append(row)

            # Batch insert
            success = gcloud_db.insert_table_rows(project_id, dataset_id, table_name, rows)

            if success:
                print(f"✅ Successfully inserted {len(rows)} customer records")
            else:
                print(f"❌ Data insertion failed")
                raise Exception("Data insertion failed")
        else:
            print("⚠️  No data to insert")

        return f"{project_id}.{dataset_id}"

    except Exception as e:
        print(f"❌ BigQuery resource setup failed: {e}")
        logger.exception("BigQuery setup failed")
        raise

if __name__ == "__main__":
    main()