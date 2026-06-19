import argparse
import os
import asyncio
import sys
import json
import shutil
from pathlib import Path
from datetime import datetime
from rich import print

# Add project root to Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
# Note: task_dir will be determined from args.agent_workspace, not from code location
# Go up: preprocess -> payable_invoice_checker_s2l -> envs -> gem -> gem -> root
project_root = os.path.abspath(os.path.join(current_dir, '..', '..', '..', '..', '..'))
sys.path.insert(0, project_root)

from gem.utils.filesystem import nfs_safe_rmtree



from mcp_convert.mcps.snowflake.database_utils import SnowflakeDatabase
from mcp_convert.mcps.email.database_utils import EmailDatabase

from . import generate_test_invoices


def ensure_users_exist(db: EmailDatabase, users_info: list) -> bool:
    """Ensure users exist in the database"""
    print(f"👥 Ensuring {len(users_info)} users exist in database...")
    
    try:
        # Load or initialize users.json
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


def clear_email_database(db: EmailDatabase, user_email: str) -> bool:
    """Clear email data for specified user"""
    print(f"🗑️  Clearing email database: {user_email}...")
    
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
                "Trash": {"total": 0, "unread": 0},
                "Drafts": {"total": 0, "unread": 0}
            })
            db._save_json_file(os.path.join(user_dir, "drafts.json"), {})
            print(f"   ✓ Created new user data: {user_email}")
        else:
            # Clear existing data
            db._save_json_file(os.path.join(user_dir, "emails.json"), {})
            db._save_json_file(os.path.join(user_dir, "folders.json"), {
                "INBOX": {"total": 0, "unread": 0},
                "Sent": {"total": 0, "unread": 0},
                "Trash": {"total": 0, "unread": 0},
                "Drafts": {"total": 0, "unread": 0}
            })
            db._save_json_file(os.path.join(user_dir, "drafts.json"), {})
            print(f"   ✓ Cleared: {user_email}")
        
        return True
    except Exception as e:
        print(f"   ❌ Clear failed: {e}")
        import traceback
        traceback.print_exc()
        return False


async def initialize_snowflake_local(snowflake_db_dir: str, groundtruth_dir: Path, num_interference: int = 1000) -> bool:
    """Initialize Snowflake database using local database
    
    Args:
        snowflake_db_dir: Snowflake database directory
        groundtruth_dir: Directory to save groundtruth data
        num_interference: Number of interference records to generate
    """
    print("\n🏦 Initializing Snowflake Database (Local Database)...")
    print("=" * 60)
    
    try:
        # Clean and initialize Snowflake database
        print("🗑️  Cleaning Snowflake database...")
        if Path(snowflake_db_dir).exists():
            nfs_safe_rmtree(snowflake_db_dir)
            print("   ✓ Removed old database")
        
        Path(snowflake_db_dir).mkdir(parents=True, exist_ok=True)
        print("   ✓ Created fresh database directory")
        
        # Initialize SnowflakeDatabase
        db = SnowflakeDatabase(data_dir=snowflake_db_dir)
        print("   ✓ Initialized Snowflake database")
        
        # Create INVOICES table (database and schema will be auto-registered)
        print("\n📋 Creating INVOICES table...")
        create_invoices_sql = """
        CREATE TABLE PURCHASE_INVOICE.PUBLIC.INVOICES (
            INVOICE_ID VARCHAR(100) PRIMARY KEY,
            SUPPLIER_NAME VARCHAR(500) NOT NULL,
            INVOICE_AMOUNT DECIMAL(15,2) NOT NULL,
            PURCHASER_EMAIL VARCHAR(255) NOT NULL,
            INVOICE_DATE DATE
        )
        """
        db.execute_write_query(create_invoices_sql)
        print("   ✓ INVOICES table created")
        
        # Create INVOICE_PAYMENTS table
        print("\n📋 Creating INVOICE_PAYMENTS table...")
        create_payments_sql = """
        CREATE TABLE PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS (
            INVOICE_ID VARCHAR(100) PRIMARY KEY,
            PAYMENT_AMOUNT DECIMAL(15,2) DEFAULT 0.00,
            OUTSTANDING_FLAG INTEGER DEFAULT 1 COMMENT '0=Paid, 1=Outstanding'
        )
        """
        db.execute_write_query(create_payments_sql)
        print("   ✓ INVOICE_PAYMENTS table created")
        print("   ✓ OUTSTANDING_FLAG column comment added: '0=Paid, 1=Outstanding'")
        print("   ✓ Database and schema auto-registered: PURCHASE_INVOICE.PUBLIC")
        
        # Generate and insert test data (interference data)
        print(f"\n📋 Generating and inserting interference data ({num_interference} records)...")
        generate_test_invoices.random.seed(42)
        
        # Generate interference invoices
        invoices_data = []
        supplier_types = list(generate_test_invoices.SUPPLIERS_CONFIG.keys())
        interference_buyer_emails = [
            "JSmith@mcp.com",
            "MBrown@mcp.com",
            "AWilliams@mcp.com",
            "RJohnson@mcp.com",
            "LDavis@mcp.com",
            "KWilliams@mcp.com",
            "TMiller@mcp.com",
            "SAnderson@mcp.com"
        ]
        
        # Generate interference records
        print(f"🎭 Generating {num_interference} interference records...")
        for i in range(1, num_interference + 1):
            supplier_type = generate_test_invoices.random.choice(supplier_types)
            supplier_config = generate_test_invoices.SUPPLIERS_CONFIG[supplier_type]
            buyer_email = generate_test_invoices.random.choice(interference_buyer_emails)
            
            items = generate_test_invoices.generate_invoice_items(supplier_type)
            total_amount = sum(item['total'] for item in items)
            
            # All interference data is paid
            payment_status = {
                "paid_amount": total_amount,
                "status": "paid",
                "flag": 0,
                "show_status": True
            }
            
            # Generate dates from 2022-2023
            year = generate_test_invoices.random.choice([2022, 2023])
            month = generate_test_invoices.random.randint(1, 12)
            day = generate_test_invoices.random.randint(1, 28)
            date_str = f"{year}-{month:02d}-{day:02d}"
            
            # Generate unique invoice ID
            interference_formats = [
                f"INT-{year}-{i:04d}",
                f"NOISE-{10000 + i}",
                f"FAKE-{100000 + i}",
                f"TEST{1000 + i}-{year}",
                f"DIST-{year}-{100 + (i % 900)}"
            ]
            invoice_id = generate_test_invoices.random.choice(interference_formats)
            
            invoice_data = {
                "invoice_number": invoice_id,
                "supplier_name": supplier_config["name"],
                "invoice_amount": total_amount,
                "purchaser_email": buyer_email,
                "invoice_date": date_str,
                "paid_amount": payment_status["paid_amount"],
                "outstanding_flag": payment_status["flag"],
                "is_interference": True
            }
            
            invoices_data.append(invoice_data)
        
        print(f"   ✓ Generated {len(invoices_data)} interference records")
        
        # Insert data into database
        print("\n📦 Inserting data into database...")
        inserted_count = 0
        failed_count = 0
        
        for idx, invoice in enumerate(invoices_data, 1):
            try:
                # Insert invoice
                invoice_insert = f"""
                INSERT INTO PURCHASE_INVOICE.PUBLIC.INVOICES 
                (INVOICE_ID, SUPPLIER_NAME, INVOICE_AMOUNT, PURCHASER_EMAIL, INVOICE_DATE)
                VALUES ('{invoice['invoice_number']}', '{invoice['supplier_name'].replace("'", "''")}', 
                        {invoice['invoice_amount']:.2f}, '{invoice['purchaser_email']}', '{invoice['invoice_date']}')
                """
                db.execute_write_query(invoice_insert)
                
                # Insert payment
                payment_insert = f"""
                INSERT INTO PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS 
                (INVOICE_ID, PAYMENT_AMOUNT, OUTSTANDING_FLAG)
                VALUES ('{invoice['invoice_number']}', {invoice['paid_amount']:.2f}, {invoice['outstanding_flag']})
                """
                db.execute_write_query(payment_insert)
                
                inserted_count += 1
                
                if idx % 100 == 0:
                    print(f"   Progress: {idx}/{len(invoices_data)} (inserted: {inserted_count}, failed: {failed_count})")
            except Exception as e:
                failed_count += 1
                if failed_count <= 5:  # Only print first 5 errors
                    print(f"   ⚠️  Failed to insert invoice {invoice['invoice_number']}: {e}")
        
        print(f"   ✓ Inserted {inserted_count} records (failed: {failed_count})")
        
        # Export interference data to groundtruth_workspace
        print("\n💾 Exporting interference data to groundtruth_workspace...")
        groundtruth_dir.mkdir(parents=True, exist_ok=True)
        
        # Export invoices
        invoices_file = groundtruth_dir / "interference_invoices.jsonl"
        with open(invoices_file, 'w', encoding='utf-8') as f:
            for invoice in invoices_data:
                invoice_record = {
                    "invoice_id": invoice["invoice_number"],
                    "supplier_name": invoice["supplier_name"],
                    "invoice_amount": invoice["invoice_amount"],
                    "purchaser_email": invoice["purchaser_email"],
                    "invoice_date": invoice["invoice_date"]
                }
                f.write(json.dumps(invoice_record, ensure_ascii=False) + '\n')
        print(f"   ✓ Exported: {invoices_file}")
        
        # Export payments
        payments_file = groundtruth_dir / "interference_payments.jsonl"
        with open(payments_file, 'w', encoding='utf-8') as f:
            for invoice in invoices_data:
                payment_record = {
                    "invoice_id": invoice["invoice_number"],
                    "payment_amount": invoice["paid_amount"],
                    "outstanding_flag": invoice["outstanding_flag"]
                }
                f.write(json.dumps(payment_record, ensure_ascii=False) + '\n')
        print(f"   ✓ Exported: {payments_file}")
        
        # Verify setup
        print("\n📋 Verifying setup...")
        invoice_count = db.execute_query("SELECT COUNT(*) as count FROM PURCHASE_INVOICE.PUBLIC.INVOICES")
        payment_count = db.execute_query("SELECT COUNT(*) as count FROM PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS")
        print(f"   ✓ Total invoices: {invoice_count[0]['COUNT'] if invoice_count else 0}")
        print(f"   ✓ Total payments: {payment_count[0]['COUNT'] if payment_count else 0}")
        
        print("\n✅ Snowflake database initialized successfully!")
        return True
        
    except Exception as e:
        print(f"❌ Snowflake database initialization failed: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main():
    parser = argparse.ArgumentParser(description="Payable Invoice Checker - Preprocess Setup")
    parser.add_argument("--agent_workspace", type=str, required=False, help="Agent workspace directory")
    parser.add_argument("--launch_time", type=str, required=False, help="Launch time")
    
    # Data generation control parameters
    parser.add_argument("--num-invoices", type=int, default=30,
                       help="Number of invoice PDFs to generate (default: 15)")
    parser.add_argument("--num-interference", type=int, default=1000,
                       help="Number of interference records in database (default: 1000)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    parser.add_argument("--skip-pdf", action="store_true", 
                       help="Skip PDF generation and only create database")
    
    # Difficulty presets
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert", "extreme"],
                       help="Difficulty preset (optional, overrides other parameters)")

    args = parser.parse_args()
    
    # Apply difficulty presets
    if args.difficulty:
        print(f"🎲 Using difficulty preset: {args.difficulty.upper()}")
        
        if args.difficulty == "easy":
            # Easy: Few invoices, minimal interference
            args.num_invoices = 5
            args.num_interference = 100
        elif args.difficulty == "medium":
            # Medium: Moderate invoices and interference
            args.num_invoices = 15
            args.num_interference = 1000
        elif args.difficulty == "hard":
            # Hard: More invoices and interference
            args.num_invoices = 30
            args.num_interference = 3000
        elif args.difficulty == "expert":
            # Expert: Many invoices with high interference
            args.num_invoices = 50
            args.num_interference = 5000
        elif args.difficulty == "extreme":
            # Extreme: Maximum complexity
            args.num_invoices = 100
            args.num_interference = 10000
    else:
        print(f"🎲 Using custom parameters")

    print("\n" + "="*60)
    print("🎯 PAYABLE INVOICE CHECKER - PREPROCESSING (Local Database)")
    print("="*60)
    print("Using local databases (Snowflake + Email)")
    
    if not args.skip_pdf:
        print(f"\n📊 Data generation parameters:")
        print(f"   Invoice PDFs: {args.num_invoices}")
        print(f"   Interference records: {args.num_interference}")
        print(f"   Random seed: {args.seed}")
        if args.difficulty:
            print(f"   Difficulty: {args.difficulty.upper()}")
    
    # Set random seed for consistency
    generate_test_invoices.random.seed(args.seed)
    
    # Determine task directory and database directories
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        task_root = workspace_parent  # Task root is parent of agent_workspace
        snowflake_db_dir = str(workspace_parent / "local_db" / "snowflake")
        email_db_dir = str(workspace_parent / "local_db" / "emails")
    else:
        # Fallback to code directory (for standalone testing)
        task_root = Path(__file__).parent.parent
        snowflake_db_dir = str(Path(__file__).parent.parent / "mcps" / "snowflake" / "data")
        email_db_dir = str(Path(__file__).parent.parent / "mcps" / "email" / "data")
    
    print(f"\n📂 Database Directories:")
    print(f"   Snowflake: {snowflake_db_dir}")
    print(f"   Email: {email_db_dir}")
    
    if not args.skip_pdf:
        # Step 1: Generate test invoices PDFs
        print("\n" + "="*60)
        print("PREPROCESSING STEP 1: Generate Test Invoice PDFs")
        print("="*60)
        
        # Create files directory in the agent workspace
        if args.agent_workspace:
            files_dir = os.path.join(args.agent_workspace, "files")
        else:
            files_dir = os.path.join(task_root, "files")
        
        # Generate test invoices
        invoices = []
        supplier_types = list(generate_test_invoices.SUPPLIERS_CONFIG.keys())
        buyer_emails = list(generate_test_invoices.BUYERS_CONFIG.keys())
        template_styles = list(generate_test_invoices.TEMPLATE_STYLES.keys())
        
        if not os.path.exists(files_dir):
            os.makedirs(files_dir)
        
        # Generate invoices
        for i in range(1, args.num_invoices + 1):
            supplier_type = generate_test_invoices.random.choice(supplier_types)
            supplier_config = generate_test_invoices.SUPPLIERS_CONFIG[supplier_type]
            buyer_email = generate_test_invoices.random.choice(buyer_emails)
            
            # Generate items and payment status
            items = generate_test_invoices.generate_invoice_items(supplier_type)
            total_amount = sum(item['total'] for item in items)
            payment_status = generate_test_invoices.generate_random_payment_status(total_amount)
            
            # Generate random date
            month = generate_test_invoices.random.randint(1, 12)
            day = generate_test_invoices.random.randint(1, 28)
            date_str = f"2024-{month:02d}-{day:02d}"
            
            # Generate invoice ID formats
            invoice_formats = [
                f"INV-2024-{i:03d}",
                f"2024-{generate_test_invoices.random.randint(1000, 9999)}",
                f"MCP-{generate_test_invoices.random.randint(100000, 999999)}",
                f"PO{generate_test_invoices.random.randint(10000, 99999)}-24",
                f"BL-2024-{generate_test_invoices.random.randint(100, 999)}",
            ]
            invoice_id = generate_test_invoices.random.choice(invoice_formats)
            
            invoice = {
                "invoice_id": invoice_id,
                "date": date_str,
                "supplier": supplier_config["name"],
                "supplier_address": supplier_config["address"],
                "buyer_email": buyer_email,
                "total_amount": total_amount,
                "bank_account": supplier_config["bank_account"],
                "items": items,
                "payment_status": payment_status
            }
            
            # Generate PDF with rotating template styles
            template_style = template_styles[i % len(template_styles)]
            filename = os.path.join(files_dir, f"{invoice_id}.pdf")
            generate_test_invoices.create_invoice_pdf(filename, invoice, template_style)
            
            invoices.append(invoice)
            print(f"Generated: {filename} - {template_style} style")
        
        print(f"\n✅ Generated {len(invoices)} test invoice PDF files in {files_dir}")
        
        # Step 1.5: Generate groundtruth invoice.jsonl file
        print("\n" + "-"*40)
        print("STEP 1.5: Generate Groundtruth Invoice Data")
        print("-"*40)
        
        # Create groundtruth workspace directory in the task directory
        groundtruth_dir = task_root / "groundtruth_workspace"
        groundtruth_dir.mkdir(parents=True, exist_ok=True)
        
        # Write invoices to JSONL file
        groundtruth_file = groundtruth_dir / "invoice.jsonl"
        with open(groundtruth_file, 'w', encoding='utf-8') as f:
            for invoice in invoices:
                f.write(json.dumps(invoice, ensure_ascii=False) + '\n')
        
        print(f"✅ Generated groundtruth file: {groundtruth_file}")
        print(f"✅ Saved {len(invoices)} invoice records to groundtruth file")
        
        print("✅ Step 1 completed: Test invoice PDF generation and groundtruth file creation")
    else:
        print("\nℹ️ Skipping PDF generation (--skip-pdf flag)")
        print("⚠️ Groundtruth file generation also skipped (requires invoice generation)")
    
    # Step 2: Initialize Snowflake database with generated data
    print("\n" + "="*60)
    print("PREPROCESSING STEP 2: Initialize Snowflake Database")
    print("="*60)
    
    try:
        # Prepare groundtruth directory
        groundtruth_dir = task_root / "groundtruth_workspace"
        
        success = await initialize_snowflake_local(snowflake_db_dir, groundtruth_dir, num_interference=args.num_interference)
        if success:
            print("✅ Step 2 completed: Snowflake database initialization")
        else:
            print("❌ Step 2 failed: Database initialization error")
            return
    except Exception as e:
        print(f"❌ Step 2 failed: Database initialization error - {e}")
        import traceback
        traceback.print_exc()
        return
    
    # Step 3: Clean Email database
    print("\n" + "="*60)
    print("PREPROCESSING STEP 3: Setup and Clear Email Database")
    print("="*60)
    
    try:
        # Clean Email database
        if Path(email_db_dir).exists():
            nfs_safe_rmtree(email_db_dir)
            print("   ✓ Removed old Email database")
        Path(email_db_dir).mkdir(parents=True, exist_ok=True)
        print("   ✓ Created Email database directory")
        
        # Initialize EmailDatabase
        email_db = EmailDatabase(data_dir=email_db_dir)
        
        # Read involved_emails.json from code directory (static config file)
        code_dir = Path(__file__).parent.parent  # env directory
        involved_emails_file = code_dir / "files" / "involved_emails.json"
        if involved_emails_file.exists():
            with open(involved_emails_file, 'r', encoding='utf-8') as f:
                involved_emails = json.load(f)
            
            # Collect all email accounts
            users_info = []
            for role in involved_emails:
                for email_address, config in involved_emails[role].items():
                    users_info.append({
                        "email": email_address,
                        "password": config.get("password", "default_password"),
                        "name": config.get("name", email_address.split('@')[0])
                    })
            
            # Create users
            if ensure_users_exist(email_db, users_info):
                print("   ✓ Users created")
            
            # Clear email folders for all users
            for user_info in users_info:
                clear_email_database(email_db, user_info['email'])
            
            print(f"✅ Email database initialized and cleared for {len(users_info)} users")
        else:
            print(f"⚠️ involved_emails.json not found: {involved_emails_file}")
            print("   Creating default email database")
        
    except Exception as e:
        print(f"❌ Email database setup failed: {e}")
        import traceback
        traceback.print_exc()
    
    # Set environment variables
    os.environ['SNOWFLAKE_DATA_DIR'] = snowflake_db_dir
    os.environ['EMAIL_DATA_DIR'] = email_db_dir
    
    # Write environment variable file
    if args.agent_workspace:
        env_file = Path(args.agent_workspace).parent / "local_db" / ".env"
    else:
        env_file = Path(snowflake_db_dir).parent / ".env"
    
    try:
        env_file.parent.mkdir(parents=True, exist_ok=True)
        with open(env_file, 'w') as f:
            f.write(f"# Payable Invoice Checker Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export SNOWFLAKE_DATA_DIR={snowflake_db_dir}\n")
            f.write(f"export EMAIL_DATA_DIR={email_db_dir}\n")
        print(f"\n📄 Environment variable file created: {env_file}")
    except Exception as e:
        print(f"⚠️ Unable to create environment variable file: {e}")

    print("\n" + "="*60)
    print("🎉 PREPROCESSING COMPLETED SUCCESSFULLY!")
    print("="*60)
    print("✅ PDF invoices generated (if not skipped)")
    print("✅ Groundtruth invoice.jsonl file created (if not skipped)")
    print(f"✅ Snowflake database initialized with interference data ({args.num_interference} records)")
    print("✅ Email database initialized and cleared")
    print("✅ Ready for invoice processing workflow")
    
    print(f"\n📂 Database Locations:")
    print(f"   Snowflake: {snowflake_db_dir}")
    print(f"   Email: {email_db_dir}")
    
    if not args.skip_pdf:
        print(f"\n📊 Generated Data Statistics:")
        print(f"   Invoice PDFs: {args.num_invoices}")
        print(f"   Interference records: {args.num_interference}")
        print(f"   Random seed: {args.seed}")
        if args.difficulty:
            print(f"   Difficulty: {args.difficulty.upper()}")
    
    print(f"\n📌 Environment Variables:")
    print(f"   SNOWFLAKE_DATA_DIR={snowflake_db_dir}")
    print(f"   EMAIL_DATA_DIR={email_db_dir}")


if __name__ == "__main__":
    asyncio.run(main())