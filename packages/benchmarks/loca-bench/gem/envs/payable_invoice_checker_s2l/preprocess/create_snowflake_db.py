#!/usr/bin/env python3
"""
Snowflake Database Initialization Script
Uses MCP Snowflake server to initialize the database for the supplier invoice reconciliation system
"""

import argparse
import asyncio
import importlib.util
import json
import os
import random
import sys
from rich import print
from rich.console import Console
from rich.table import Table

# Add project root directory to Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
# Go up: preprocess -> payable-invoice-checker -> fan -> tasks -> mcpbench_dev
project_root = os.path.abspath(os.path.join(current_dir, '..', '..', '..', '..'))
sys.path.insert(0, project_root)
try:
    from utils.mcp.tool_servers import MCPServerManager, call_tool_with_retry
except ImportError as e:
    print(f"Import error: {e}")
    print("Please run from the project root directory or ensure the project structure is correct")
    sys.exit(1)

# Import test invoice generation module
from . import generate_test_invoices

# Import task-specific configuration for override
# Add parent directory to path and import
local_token_key_session_file = os.path.join(os.path.dirname(__file__), "..", "token_key_session.py")
try:
    # from local_token_key_session import all_token_key_session as local_token_key_session
    # Use importlib.util to import module from file path
    spec = importlib.util.spec_from_file_location("token_key_session", local_token_key_session_file)
    token_key_session_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(token_key_session_module)
    local_token_key_session = token_key_session_module.all_token_key_session
except ImportError:
    print("Warning: Task-specific token_key_session.py not found, using default configuration")
    local_token_key_session = {
        "snowflake_op_allowed_databases": "PURCHASE_INVOICE",
    }

console = Console()


def display_table_structure():
    """Display the table structure to be created"""
    print("\n" + "="*60)
    print("📋 DATABASE SCHEMA DESIGN")
    print("="*60)
    
    # Invoices table structure
    invoices_table = Table(title="INVOICES Table Structure")
    invoices_table.add_column("Column", style="cyan")
    invoices_table.add_column("Type", style="magenta")
    invoices_table.add_column("Description", style="green")
    
    invoices_table.add_row("INVOICE_ID", "VARCHAR(100)", "Invoice number (primary key, formatted)")
    invoices_table.add_row("SUPPLIER_NAME", "VARCHAR(500)", "Supplier name")
    invoices_table.add_row("INVOICE_AMOUNT", "DECIMAL(15,2)", "Invoice amount")
    invoices_table.add_row("PURCHASER_EMAIL", "VARCHAR(255)", "Purchaser email")
    invoices_table.add_row("INVOICE_DATE", "DATE", "Invoice date")
    
    console.print(invoices_table)
    
    # Payments table structure  
    payments_table = Table(title="INVOICE_PAYMENTS Table Structure")
    payments_table.add_column("Column", style="cyan")
    payments_table.add_column("Type", style="magenta") 
    payments_table.add_column("Description", style="green")
    
    payments_table.add_row("INVOICE_ID", "VARCHAR(100)", "Invoice number (primary key, foreign key)")
    payments_table.add_row("PAYMENT_AMOUNT", "DECIMAL(15,2)", "Payment amount")
    payments_table.add_row("OUTSTANDING_FLAG", "INTEGER", "Outstanding flag (1=outstanding, 0=paid)")
    
    console.print(payments_table)


async def execute_sql(server, sql_query: str, description: str = "", tool_type: str = "write"):
    """Execute SQL query"""
    try:
        if description:
            print(f"🔄 {description}")
        
        # Select appropriate tool based on SQL type
        if tool_type == "create":
            tool_name = "create_table"
            arguments = {"query": sql_query}
        elif tool_type == "read":
            tool_name = "read_query"
            arguments = {"query": sql_query}
        else:  # write operations (INSERT, UPDATE, DELETE, DROP, etc.)
            tool_name = "write_query"
            arguments = {"query": sql_query}
        
        # Call MCP tool to execute SQL
        result = await call_tool_with_retry(
            server,
            tool_name=tool_name,
            arguments=arguments
        )
        
        print(f"✅ {description or 'SQL executed successfully'}")
        if hasattr(result, 'content') and result.content:
            # Try different ways to access the result
            if hasattr(result.content[0], 'text'):
                print(f"   Result: {result.content[0].text}")
            elif hasattr(result.content[0], 'content'):
                print(f"   Result: {result.content[0].content}")
        return True
        
    except Exception as e:
        print(f"❌ Error executing SQL ({description}): {e}")
        return False


async def generate_invoice_data(num_interference: int = 1000):
    """Generate test invoice data

    Args:
        num_interference: Number of interference records to generate
    """
    invoices_data = []

    supplier_types = list(generate_test_invoices.SUPPLIERS_CONFIG.keys())

    # Use global invoice ID set to ensure no conflict with real invoices
    def generate_unique_invoice_id(year, prefix_type="interference"):
        """Generate unique invoice ID"""
        max_attempts = 1000  # Prevent infinite loop
        attempt = 0

        while attempt < max_attempts:
            if prefix_type == "interference":
                # Interference data uses multiple formats but ensures uniqueness
                interference_formats = [
                    f"INT-{year}-{random.randint(1, 2000):04d}",
                    f"NOISE-{random.randint(10000, 99999)}",
                    f"FAKE-{random.randint(100000, 999999)}",
                    f"TEST{random.randint(1000, 9999)}-{year}",
                    f"DIST-{year}-{random.randint(100, 999)}"
                ]
                invoice_id = random.choice(interference_formats)
            else:
                # Real invoice format
                real_formats = [
                    f"INV-2024-{random.randint(1, 2000):03d}",
                    f"2024-{random.randint(1000, 9999)}",
                    f"MCP-{random.randint(100000, 999999)}",
                    f"PO{random.randint(10000, 99999)}-24",
                    f"BL-2024-{random.randint(100, 999)}",
                    f"REF{random.randint(1000, 9999)}24",
                    f"INV{random.randint(100000, 999999)}"
                ]
                invoice_id = random.choice(real_formats)

            # Check if already exists in global set
            if invoice_id not in generate_test_invoices.USED_INVOICE_IDS:
                generate_test_invoices.USED_INVOICE_IDS.add(invoice_id)
                return invoice_id

            attempt += 1

        # If unable to generate unique ID after multiple attempts, use timestamp to ensure uniqueness
        import time
        timestamp = int(time.time() * 1000)
        unique_id = f"UNIQUE-{timestamp}-{random.randint(1000, 9999)}"
        generate_test_invoices.USED_INVOICE_IDS.add(unique_id)
        return unique_id

    # Interference data uses dedicated email list to avoid overlap with groundtruth emails
    interference_buyer_emails = [
        "JSmith@mcp.com",
        "MBrown@mcp.com",
        "AWilliams@mcp.com",
        "RJohnson@mcp.com",
        "LDavis@mcp.com",
        "KWilson@mcp.com",
        "TMiller@mcp.com",
        "SAnderson@mcp.com"
    ]

    # Generate interference data first, using earlier dates
    print(f"🎭 Generating interference data ({num_interference} records)...")
    for i in range(1, num_interference + 1):  # Interference data
        supplier_type = generate_test_invoices.random.choice(supplier_types)
        supplier_config = generate_test_invoices.SUPPLIERS_CONFIG[supplier_type]
        buyer_email = generate_test_invoices.random.choice(interference_buyer_emails)

        # Generate items and total amount
        items = generate_test_invoices.generate_invoice_items(supplier_type)
        total_amount = sum(item['total'] for item in items)

        # Interference data: all set to paid status
        payment_status = {
            "paid_amount": total_amount,  # Paid amount equals invoice amount
            "status": "paid",            # Status is paid
            "flag": 0,                   # Outstanding flag is 0 (paid)
            "show_status": True
        }

        # Generate earlier dates (2022-2023)
        year = generate_test_invoices.random.choice([2022, 2023])
        month = generate_test_invoices.random.randint(1, 12)
        day = generate_test_invoices.random.randint(1, 28)
        date_str = f"{year}-{month:02d}-{day:02d}"

        # Generate unique interference invoice number, ensuring uniqueness
        invoice_id = generate_unique_invoice_id(year, "interference")

        invoice_data = {
            "invoice_number": invoice_id,
            "supplier_name": supplier_config["name"],
            "invoice_amount": total_amount,
            "purchaser_email": buyer_email,
            "invoice_date": date_str,
            "paid_amount": payment_status["paid_amount"],  # equals total_amount
            "outstanding_flag": payment_status["flag"],    # 0 means paid
            "is_interference": True  # Marked as interference data
        }

        invoices_data.append(invoice_data)

    # Pre-generate 16 real invoice IDs to ensure no conflict with interference data
    print("🎯 Pre-generating 16 real invoice IDs to ensure uniqueness...")
    for i in range(1, 17):  # 16 real invoices
        real_invoice_id = generate_unique_invoice_id(2024, "real")
        print(f"Pre-generated real invoice ID: {real_invoice_id}")

    print(f"✅ Pre-generated 16 unique real invoice IDs, current total global IDs: {len(generate_test_invoices.USED_INVOICE_IDS)}")

    # Skip original data generation, let agent read from PDF
    print("🚫 Skipping original data generation - agent will read from PDF")

    # Sort all data by date (generally ascending, but allow some shuffling)
    invoices_data.sort(key=lambda x: x['invoice_date'])

    # Slightly shuffle the sorted data (maintain overall ascending trend)
    random.seed(42)  # Ensure reproducibility

    # Randomly swap a few items within every 10 records, maintain overall ascending order
    for i in range(0, len(invoices_data) - 10, 10):
        end_idx = min(i + 10, len(invoices_data))
        chunk = invoices_data[i:end_idx]

        # Randomly swap 2-3 pairs of positions
        for _ in range(random.randint(2, 3)):
            if len(chunk) >= 2:
                idx1, idx2 = random.sample(range(len(chunk)), 2)
                chunk[idx1], chunk[idx2] = chunk[idx2], chunk[idx1]

        invoices_data[i:end_idx] = chunk

    print(f"✅ Generated {len(invoices_data)} interference records")

    # Export interference data to groundtruth_workspace
    await export_interference_data(invoices_data)

    return invoices_data

async def export_interference_data(invoices_data):
    """Export interference data to groundtruth_workspace directory"""
    print("🎭 Exporting interference data...")

    # Create output directory
    current_dir = os.path.dirname(os.path.abspath(__file__))
    task_root = os.path.dirname(current_dir)
    output_dir = os.path.join(task_root, "groundtruth_workspace")
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # All data is interference data
    interference_data = invoices_data

    print(f"📊 Interference data: {len(interference_data)} records")

    # Export interference data - INVOICES format
    if interference_data:
        invoices_file = os.path.join(output_dir, "interference_invoices.jsonl")
        with open(invoices_file, 'w', encoding='utf-8') as f:
            for item in interference_data:
                invoice_record = {
                    "invoice_id": item["invoice_number"],
                    "supplier_name": item["supplier_name"],
                    "invoice_amount": item["invoice_amount"],
                    "purchaser_email": item["purchaser_email"],
                    "invoice_date": item["invoice_date"]
                }
                f.write(json.dumps(invoice_record, ensure_ascii=False) + '\n')

        print(f"✅ Exported interference invoice data: {invoices_file}")

    # Export interference data - INVOICE_PAYMENTS format
    if interference_data:
        payments_file = os.path.join(output_dir, "interference_payments.jsonl")
        with open(payments_file, 'w', encoding='utf-8') as f:
            for item in interference_data:
                payment_record = {
                    "invoice_id": item["invoice_number"],
                    "payment_amount": item["paid_amount"],  # equals total_amount
                    "outstanding_flag": item["outstanding_flag"]  # 0 means paid
                }
                f.write(json.dumps(payment_record, ensure_ascii=False) + '\n')

        print(f"✅ Exported interference payment data: {payments_file}")

    print(f"🎭 Interference data export completed, total {len(interference_data)} records")


async def export_database_to_jsonl():
    """Export database content to JSONL files"""
    print("📤 DATABASE EXPORT TO JSONL")
    print("=" * 60)
    print("Database: PURCHASE_INVOICE")
    print("Schema: PUBLIC")
    print("Purpose: Export database content to groundtruth workspace")

    # Create MCP server manager
    mcp_manager = MCPServerManager(
        agent_workspace="./",
        config_dir="configs/mcp_servers",
        local_token_key_session=local_token_key_session
    )

    try:
        # Get Snowflake server
        snowflake_server = mcp_manager.servers['snowflake']

        async with snowflake_server as server:
            # Query INVOICES table
            print("\n📋 Exporting INVOICES table...")
            invoices_query = """
            SELECT
                INVOICE_ID,
                SUPPLIER_NAME,
                INVOICE_AMOUNT,
                PURCHASER_EMAIL,
                INVOICE_DATE
            FROM PURCHASE_INVOICE.PUBLIC.INVOICES
            ORDER BY INVOICE_ID;
            """

            invoices_result = await execute_sql(
                server,
                invoices_query,
                "Querying INVOICES table for export",
                "read"
            )

            # Query INVOICE_PAYMENTS table
            print("\n📋 Exporting INVOICE_PAYMENTS table...")
            payments_query = """
            SELECT
                INVOICE_ID,
                PAYMENT_AMOUNT,
                OUTSTANDING_FLAG
            FROM PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS
            ORDER BY INVOICE_ID;
            """

            payments_result = await execute_sql(
                server,
                payments_query,
                "Querying INVOICE_PAYMENTS table for export",
                "read"
            )

            # Create output directory
            current_dir = os.path.dirname(os.path.abspath(__file__))
            task_root = os.path.dirname(current_dir)
            output_dir = os.path.join(task_root, "groundtruth_workspace")
            if not os.path.exists(output_dir):
                os.makedirs(output_dir)

            # Parse and export INVOICES data
            if invoices_result:
                print("\n💾 Exporting INVOICES data to JSONL...")
                invoices_file = os.path.join(output_dir, "db_invoices.jsonl")

                with open(invoices_file, 'w', encoding='utf-8') as f:
                    lines = invoices_result.strip().split('\n')
                    if len(lines) > 2:  # Skip header and separator
                        data_lines = [line for line in lines[2:] if line.strip() and not line.startswith('---')]

                        for line in data_lines:
                            parts = [part.strip() for part in line.split('|') if part.strip()]
                            if len(parts) >= 5:
                                invoice_record = {
                                    "invoice_id": parts[0],
                                    "supplier_name": parts[1],
                                    "invoice_amount": float(parts[2]) if parts[2] else 0.0,
                                    "purchaser_email": parts[3],
                                    "invoice_date": parts[4]
                                }
                                f.write(json.dumps(invoice_record, ensure_ascii=False) + '\n')

                print(f"✅ Exported INVOICES data to: {invoices_file}")

            # Parse and export INVOICE_PAYMENTS data
            if payments_result:
                print("\n💾 Exporting INVOICE_PAYMENTS data to JSONL...")
                payments_file = os.path.join(output_dir, "db_payments.jsonl")

                with open(payments_file, 'w', encoding='utf-8') as f:
                    lines = payments_result.strip().split('\n')
                    if len(lines) > 2:  # Skip header and separator
                        data_lines = [line for line in lines[2:] if line.strip() and not line.startswith('---')]

                        for line in data_lines:
                            parts = [part.strip() for part in line.split('|') if part.strip()]
                            if len(parts) >= 3:
                                payment_record = {
                                    "invoice_id": parts[0],
                                    "payment_amount": float(parts[1]) if parts[1] else 0.0,
                                    "outstanding_flag": int(parts[2]) if parts[2] else 0
                                }
                                f.write(json.dumps(payment_record, ensure_ascii=False) + '\n')

                print(f"✅ Exported INVOICE_PAYMENTS data to: {payments_file}")


            print("\n🎉 DATABASE EXPORT COMPLETED SUCCESSFULLY!")
            print("=" * 60)
            print("📁 Files exported to groundtruth_workspace/:")
            if invoices_result:
                print("   • db_invoices.jsonl - INVOICES table data (interference only)")
            if payments_result:
                print("   • db_payments.jsonl - INVOICE_PAYMENTS table data (interference only)")

    except Exception as e:
        print(f"❌ Database export failed: {e}")
        return False

    return True


async def initialize_database(num_interference: int = 1000):
    """Main logic for database initialization

    Args:
        num_interference: Number of interference records to generate
    """
    print("🏦 SNOWFLAKE DATABASE INITIALIZATION")
    print("=" * 60)
    print("Database: PURCHASE_INVOICE")
    print("Schema: PUBLIC")
    print("Purpose: Supplier Invoice Reconciliation System")

    # Display table structure design
    display_table_structure()
    
    # Create MCP server manager
    mcp_manager = MCPServerManager(
        agent_workspace="./",
        config_dir="configs/mcp_servers",
        local_token_key_session=local_token_key_session
    )
    
    try:
        # Get Snowflake server
        snowflake_server = mcp_manager.servers['snowflake']
        
        # Connect to server
        async with snowflake_server as server:
            print("\n" + "="*60)
            print("🚀 EXECUTING DATABASE INITIALIZATION")
            print("="*60)
            
            # Skip session setup - use fully qualified names instead
            
            # 1. Drop the existing database (if any) then create new database
            # 1.1 Check if the database exists
            check_database_sql = "SELECT EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'PURCHASE_INVOICE');"
            database_exists = await execute_sql(server, check_database_sql, "Checking if database exists", "read")
            if database_exists:
                print("\n📋 Step 0: Dropping existing database...")
                await call_tool_with_retry(server, tool_name="drop_databases", arguments={"databases": ["PURCHASE_INVOICE"]})

            print("\n📋 Step 1: Creating new database...")
            await call_tool_with_retry(server, tool_name="create_databases", arguments={"databases": ["PURCHASE_INVOICE"]})
            
            # 2. Create invoices table
            print("\n📋 Step 2: Creating INVOICES table...")
            create_invoices_sql = """
            CREATE TABLE PURCHASE_INVOICE.PUBLIC.INVOICES (
                INVOICE_ID VARCHAR(100) PRIMARY KEY,
                SUPPLIER_NAME VARCHAR(500) NOT NULL,
                INVOICE_AMOUNT DECIMAL(15,2) NOT NULL,
                PURCHASER_EMAIL VARCHAR(255) NOT NULL,
                INVOICE_DATE DATE
            );"""
            
            await execute_sql(server, create_invoices_sql, "Creating INVOICES table", "create")
            
            # 3. Create payments table
            print("\n📋 Step 3: Creating INVOICE_PAYMENTS table...")
            create_payments_sql = """
            CREATE TABLE PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS (
                INVOICE_ID VARCHAR(100) PRIMARY KEY,
                PAYMENT_AMOUNT DECIMAL(15,2) DEFAULT 0.00,
                OUTSTANDING_FLAG INTEGER DEFAULT 1,
                FOREIGN KEY (INVOICE_ID) REFERENCES PURCHASE_INVOICE.PUBLIC.INVOICES(INVOICE_ID)
            );"""
            
            await execute_sql(server, create_payments_sql, "Creating INVOICE_PAYMENTS table", "create")
            
            # 4. Insert generated test data
            print(f"\n📋 Step 4: Generating and inserting test data ({num_interference} interference records)...")

            # Generate test invoice data
            invoices_data = await generate_invoice_data(num_interference=num_interference)
            print(f"Generated {len(invoices_data)} test invoices")
            
            # Batch insert invoice data - optimize performance with single batch insert
            print(f"📦 Batch inserting {len(invoices_data)} invoice records...")

            # Build batch INSERT statement
            values_list = []
            for invoice in invoices_data:
                # Handle single quotes in supplier_name
                supplier_name = invoice['supplier_name'].replace("'", "''")
                values_list.append(f"('{invoice['invoice_number']}', '{supplier_name}', {invoice['invoice_amount']:.2f}, '{invoice['purchaser_email']}', '{invoice['invoice_date']}')")

            # Batch INSERT - reduce network round trips
            batch_size = 100  # 100 records per batch
            for i in range(0, len(values_list), batch_size):
                batch_values = values_list[i:i + batch_size]
                batch_sql = f"""
                INSERT INTO PURCHASE_INVOICE.PUBLIC.INVOICES
                (INVOICE_ID, SUPPLIER_NAME, INVOICE_AMOUNT, PURCHASER_EMAIL, INVOICE_DATE)
                VALUES
                {','.join(batch_values)};
                """
                await execute_sql(server, batch_sql, f"Batch inserting invoices {i+1}-{min(i+batch_size, len(values_list))}", "write")
            
            # Batch insert payment records - optimize performance with single batch insert
            print(f"💳 Batch inserting {len(invoices_data)} payment records...")

            # Build batch INSERT statement
            payment_values_list = []
            for invoice in invoices_data:
                payment_values_list.append(f"('{invoice['invoice_number']}', {invoice['paid_amount']:.2f}, {invoice['outstanding_flag']})")

            # Batch INSERT - reduce network round trips
            for i in range(0, len(payment_values_list), batch_size):
                batch_values = payment_values_list[i:i + batch_size]
                batch_sql = f"""
                INSERT INTO PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS
                (INVOICE_ID, PAYMENT_AMOUNT, OUTSTANDING_FLAG)
                VALUES
                {','.join(batch_values)};
                """
                await execute_sql(server, batch_sql, f"Batch inserting payments {i+1}-{min(i+batch_size, len(payment_values_list))}", "write")
            
            # 5. Verify setup
            print("\n📋 Step 5: Verifying setup...")
            
            verification_queries = [
                ("SELECT COUNT(*) AS TOTAL_INVOICES FROM PURCHASE_INVOICE.PUBLIC.INVOICES;", "Counting total invoices"),
                ("SELECT COUNT(*) AS TOTAL_PAYMENTS FROM PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS;", "Counting total payments")
            ]
            
            for sql, desc in verification_queries:
                await execute_sql(server, sql, desc, "read")
            
            print("\n🎉 DATABASE INITIALIZATION COMPLETED SUCCESSFULLY!")
            print("=" * 60)
            print("✅ Tables created: INVOICES, INVOICE_PAYMENTS")
            print(f"✅ Interference data inserted ({num_interference} records)")
            print("\nReady for agent to read original data from PDF and insert into database...")
        
    except Exception as e:
        print(f"❌ Database initialization failed: {e}")
        sys.exit(1)


def main():
    """Main function"""
    parser = argparse.ArgumentParser(description="Initialize Snowflake database for invoice processing")
    parser.add_argument("--dry-run", action="store_true", help="Show table structure only without executing")
    parser.add_argument("--export", action="store_true", help="Export database content to separate JSONL files in groundtruth_workspace/")
    parser.add_argument("--init-only", action="store_true", help="Initialize database with interference data only")
    
    # Data generation control parameters
    parser.add_argument("--num-interference", type=int, default=1000,
                       help="Number of interference records to generate (default: 1000)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    
    # Difficulty presets
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert", "extreme"],
                       help="Difficulty preset (optional, overrides other parameters)")
    
    args = parser.parse_args()
    
    # Apply difficulty presets
    if args.difficulty:
        print(f"🎲 Using difficulty preset: {args.difficulty.upper()}")
        
        if args.difficulty == "easy":
            args.num_interference = 100
        elif args.difficulty == "medium":
            args.num_interference = 1000
        elif args.difficulty == "hard":
            args.num_interference = 3000
        elif args.difficulty == "expert":
            args.num_interference = 5000
        elif args.difficulty == "extreme":
            args.num_interference = 10000

    # Set random seed for reproducibility
    generate_test_invoices.random.seed(args.seed)

    if args.export:
        print("📤 EXPORTING DATABASE TO JSONL")
        print("=" * 60)
        success = asyncio.run(export_database_to_jsonl())
        if success:
            print("\n✅ Database export completed successfully!")
        else:
            print("\n❌ Database export failed!")
        exit(0 if success else 1)
    elif args.dry_run:
        print("🏦 SNOWFLAKE DATABASE INITIALIZATION (DRY RUN)")
        print("=" * 60)
        display_table_structure()
        print("\n✅ Dry run completed - use without --dry-run to execute")
    else:
        # Run async initialization
        print(f"\n📊 Initialization parameters:")
        print(f"   Interference records: {args.num_interference}")
        print(f"   Random seed: {args.seed}")
        if args.difficulty:
            print(f"   Difficulty: {args.difficulty.upper()}")
        asyncio.run(initialize_database(num_interference=args.num_interference))


if __name__ == "__main__":
    main()