#!/usr/bin/env python3
"""
Minimal, clear Snowflake database verification for payable-invoice-checker.
Goal: ensure all interference and groundtruth invoice IDs exist in DB, and no extras.
All logs are in English and focused on PASS/FAIL clarity.
Supports both local database and real Snowflake.
"""

import asyncio
import json
import os
import sys
import importlib.util
from datetime import datetime
from pathlib import Path

# Add project root to Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.abspath(os.path.join(current_dir, '..', '..', '..', '..'))
sys.path.insert(0, project_root)



try:
    from utils.mcp.tool_servers import MCPServerManager, call_tool_with_retry
    MCP_AVAILABLE = True
except ImportError:
    MCPServerManager = None
    call_tool_with_retry = None
    MCP_AVAILABLE = False
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

# Import both local and remote Snowflake support
try:
    from mcp_convert.mcps.snowflake.database_utils import SnowflakeDatabase
    LOCAL_DB_AVAILABLE = True
except ImportError:
    LOCAL_DB_AVAILABLE = False
    SnowflakeDatabase = None

try:
    from utils.app_specific.snowflake import fetch_all
    REMOTE_SNOWFLAKE_AVAILABLE = True
except ImportError:
    REMOTE_SNOWFLAKE_AVAILABLE = False
    fetch_all = None

# Load task-local token session if present
local_token_key_session_file = os.path.join(os.path.dirname(__file__), "..", "token_key_session.py")
try:
    spec = importlib.util.spec_from_file_location("token_key_session", local_token_key_session_file)
    token_key_session_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(token_key_session_module)
    local_token_key_session = token_key_session_module.all_token_key_session
except Exception:
    local_token_key_session = {
        "snowflake_op_allowed_databases": "PURCHASE_INVOICE",
    }


# Global variable to store local database instance
_local_db = None


def use_local_database() -> bool:
    """Check if we should use local database based on environment variable"""
    return os.getenv('SNOWFLAKE_DATA_DIR') is not None


def get_local_db():
    """Get or create local database instance"""
    global _local_db
    if _local_db is None:
        data_dir = os.getenv('SNOWFLAKE_DATA_DIR')
        if not data_dir:
            raise RuntimeError("SNOWFLAKE_DATA_DIR environment variable not set")
        _local_db = SnowflakeDatabase(data_dir=data_dir)
    return _local_db


def load_jsonl(path: str):
    records = []
    if not os.path.exists(path):
        return records
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def load_inputs(groundtruth_file: str):
    print_color("[INPUT] Loading groundtruth and interference data...", "cyan")
    gt = load_jsonl(groundtruth_file)
    
    # Derive groundtruth_workspace directory from the groundtruth_file parameter
    groundtruth_dir = os.path.dirname(os.path.abspath(groundtruth_file))
    interference_invoices_file = os.path.join(groundtruth_dir, "interference_invoices.jsonl")
    interference_payments_file = os.path.join(groundtruth_dir, "interference_payments.jsonl")
    interference_invoices = load_jsonl(interference_invoices_file)
    interference_payments = load_jsonl(interference_payments_file)

    gt_ids = {rec.get('invoice_id') for rec in gt if rec.get('invoice_id')}
    interference_ids = {rec.get('invoice_id') for rec in interference_invoices if rec.get('invoice_id')}
    inter_pay_map = {}
    for rec in interference_payments:
        inv_id = rec.get('invoice_id')
        if inv_id:
            inter_pay_map[inv_id] = {
                'payment_amount': rec.get('payment_amount'),
                'outstanding_flag': rec.get('outstanding_flag'),
            }
    print_color(f"  - Groundtruth invoices: {len(gt_ids)}", "blue")
    print_color(f"  - Interference invoices: {len(interference_ids)}", "blue")
    print_color(f"  - Interference payments: {len(inter_pay_map)}", "blue")
    return gt, gt_ids, interference_ids, inter_pay_map


async def db_fetch_invoice_rows() -> list:
    """Fetch rows from INVOICES table. Returns list of row arrays."""
    query = (
        "SELECT INVOICE_ID, SUPPLIER_NAME, INVOICE_AMOUNT, PURCHASER_EMAIL, INVOICE_DATE "
        "FROM PURCHASE_INVOICE.PUBLIC.INVOICES ORDER BY INVOICE_ID"
    )
    
    if use_local_database():
        # Use local database
        db = get_local_db()
        results = db.execute_query(query)
        # Convert dict results to list of lists (row arrays)
        rows = []
        for row_dict in results:
            rows.append([
                row_dict.get('INVOICE_ID'),
                row_dict.get('SUPPLIER_NAME'),
                row_dict.get('INVOICE_AMOUNT'),
                row_dict.get('PURCHASER_EMAIL'),
                row_dict.get('INVOICE_DATE')
            ])
        return rows
    else:
        # Use remote Snowflake
        return fetch_all(query + ";")


async def db_fetch_payment_rows() -> list:
    """Fetch rows from INVOICE_PAYMENTS table. Returns list of row arrays."""
    query = (
        "SELECT INVOICE_ID, PAYMENT_AMOUNT, OUTSTANDING_FLAG "
        "FROM PURCHASE_INVOICE.PUBLIC.INVOICE_PAYMENTS ORDER BY INVOICE_ID"
    )
    
    if use_local_database():
        # Use local database
        db = get_local_db()
        results = db.execute_query(query)
        # Convert dict results to list of lists (row arrays)
        rows = []
        for row_dict in results:
            rows.append([
                row_dict.get('INVOICE_ID'),
                row_dict.get('PAYMENT_AMOUNT'),
                row_dict.get('OUTSTANDING_FLAG')
            ])
        return rows
    else:
        # Use remote Snowflake
        return fetch_all(query + ";")


async def db_check_outstanding_flag_comment() -> str:
    """Check the comment on OUTSTANDING_FLAG column in INVOICE_PAYMENTS table."""
    
    if use_local_database():
        # Use local database - get column info from metadata
        db = get_local_db()
        columns = db.describe_table("PURCHASE_INVOICE", "PUBLIC", "INVOICE_PAYMENTS")
        # Find OUTSTANDING_FLAG column
        for col in columns:
            if col.get('COLUMN_NAME') == 'OUTSTANDING_FLAG':
                return col.get('COMMENT') or ""
        return ""
    else:
        # Use remote Snowflake
        query = """
        SELECT COMMENT
        FROM PURCHASE_INVOICE.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'PUBLIC'
          AND TABLE_NAME = 'INVOICE_PAYMENTS'
          AND COLUMN_NAME = 'OUTSTANDING_FLAG';
        """
        rows = fetch_all(query)
        if rows and len(rows) > 0 and len(rows[0]) > 0:
            return rows[0][0] or ""
        return ""


def verify_ids(gt_ids: set, inter_ids: set, db_rows: list) -> bool:
    print_color("[VERIFY] Comparing expected vs database...", "cyan")
    db_ids = {row[0] for row in db_rows if row and len(row) >= 1}
    expected_ids = gt_ids.union(inter_ids)

    missing_interference = inter_ids - db_ids
    missing_gt = gt_ids - db_ids
    extra_ids = db_ids - expected_ids

    if missing_interference:
        print_color(f"[FAIL] Missing {len(missing_interference)} interference IDs: {sorted(list(missing_interference))[:10]}" + (" ..." if len(missing_interference) > 10 else ""), "red")
    else:
        print_color("[PASS] All interference IDs present", "green")

    if missing_gt:
        print_color(f"[FAIL] Missing {len(missing_gt)} groundtruth IDs: {sorted(list(missing_gt))[:10]}" + (" ..." if len(missing_gt) > 10 else ""), "red")
    else:
        print_color("[PASS] All groundtruth IDs present", "green")

    if extra_ids:
        print_color(f"[FAIL] Unexpected {len(extra_ids)} IDs found in DB: {sorted(list(extra_ids))[:10]}" + (" ..." if len(extra_ids) > 10 else ""), "red")
    else:
        print_color("[PASS] No unexpected IDs in DB", "green")

    ok = not missing_interference and not missing_gt and not extra_ids
    print_color(f"[SUMMARY] Expected={len(expected_ids)} | DB={len(db_ids)} | Result={'PASS' if ok else 'FAIL'}", "magenta" if ok else "red")
    return ok


def _to_float_maybe(value):
    try:
        return float(value)
    except Exception:
        return None


def _to_int_maybe(value):
    try:
        return int(value)
    except Exception:
        try:
            return int(float(value))
        except Exception:
            return None


def verify_payments(inter_pay_map: dict, db_payment_rows: list, gt_records: list = None) -> bool:
    print_color("[VERIFY] Checking interference payments...", "cyan")
    # Build DB map id -> (amount, flag)
    db_map = {}
    for row in db_payment_rows:
        if not row:
            continue
        inv_id = row[0]
        amount = _to_float_maybe(row[1]) if len(row) > 1 else None
        flag = _to_int_maybe(row[2]) if len(row) > 2 else None
        db_map[inv_id] = (amount, flag)

    missing = []
    wrong_flag = []
    wrong_amount = []

    for inv_id, expect in inter_pay_map.items():
        if inv_id not in db_map:
            missing.append(inv_id)
            continue
        got_amount, got_flag = db_map[inv_id]
        exp_flag = _to_int_maybe(expect.get('outstanding_flag'))
        exp_amount = _to_float_maybe(expect.get('payment_amount'))

        if exp_flag is not None and got_flag is not None and got_flag != exp_flag:
            wrong_flag.append((inv_id, exp_flag, got_flag))
        if exp_amount is not None and got_amount is not None and abs(got_amount - exp_amount) > 0.01:
            wrong_amount.append((inv_id, exp_amount, got_amount))

    if missing:
        print_color(f"[FAIL] Missing interference payments: {sorted(missing)[:10]}" + (" ..." if len(missing) > 10 else ""), "red")
    else:
        print_color("[PASS] All interference payments present", "green")

    if wrong_flag:
        sample = [f"{i}(exp={e}, got={g})" for i, e, g in wrong_flag[:10]]
        print_color(f"[FAIL] OUTSTANDING_FLAG mismatch: {sample}" + (" ..." if len(wrong_flag) > 10 else ""), "red")
    else:
        print_color("[PASS] OUTSTANDING_FLAG preserved for interference payments", "green")

    if wrong_amount:
        sample = [f"{i}(exp={e:.2f}, got={g:.2f})" for i, e, g in wrong_amount[:10]]
        print_color(f"[FAIL] PAYMENT_AMOUNT mismatch: {sample}" + (" ..." if len(wrong_amount) > 10 else ""), "red")
    else:
        print_color("[PASS] PAYMENT_AMOUNT preserved for interference payments", "green")

    ok = not missing and not wrong_flag and not wrong_amount
    print_color(f"[SUMMARY] Interference payments result: {'PASS' if ok else 'FAIL'}", "magenta" if ok else "red")
    
    # Now verify groundtruth payments with strict checking
    gt_ok = True
    if gt_records:
        print_color("\n[VERIFY] Checking groundtruth payments (STRICT MODE)...", "cyan")
        gt_missing = []
        gt_wrong_flag = []
        gt_wrong_amount = []
        
        for record in gt_records:
            inv_id = record.get('invoice_id')
            if not inv_id:
                continue
            
            payment_status = record.get('payment_status', {})
            exp_flag = _to_int_maybe(payment_status.get('flag', 1))
            exp_amount = _to_float_maybe(payment_status.get('paid_amount', 0.0))
            
            if inv_id not in db_map:
                gt_missing.append(inv_id)
                continue
            
            got_amount, got_flag = db_map[inv_id]
            
            # Strict checking: flag must match exactly
            if exp_flag is not None and got_flag is not None and got_flag != exp_flag:
                gt_wrong_flag.append((inv_id, exp_flag, got_flag))
            
            # Strict checking: amount must match exactly (within 0.01 tolerance)
            if exp_amount is not None and got_amount is not None and abs(got_amount - exp_amount) > 0.01:
                gt_wrong_amount.append((inv_id, exp_amount, got_amount))
        
        if gt_missing:
            print_color(f"[FAIL] Missing groundtruth payments: {sorted(gt_missing)}", "red")
            gt_ok = False
        else:
            print_color("[PASS] All groundtruth payments present", "green")
        
        if gt_wrong_flag:
            sample = [f"{i}(expected={e}, got={g})" for i, e, g in gt_wrong_flag]
            print_color(f"[FAIL] Groundtruth OUTSTANDING_FLAG mismatch: {sample}", "red")
            gt_ok = False
        else:
            print_color("[PASS] All groundtruth OUTSTANDING_FLAG correct", "green")
        
        if gt_wrong_amount:
            sample = [f"{i}(expected={e:.2f}, got={g:.2f})" for i, e, g in gt_wrong_amount]
            print_color(f"[FAIL] Groundtruth PAYMENT_AMOUNT mismatch: {sample}", "red")
            gt_ok = False
        else:
            print_color("[PASS] All groundtruth PAYMENT_AMOUNT correct", "green")
        
        print_color(f"[SUMMARY] Groundtruth payments result: {'PASS' if gt_ok else 'FAIL'}", "magenta" if gt_ok else "red")
    
    return ok and gt_ok


def verify_outstanding_flag_comment(comment: str) -> bool:
    """Verify that the OUTSTANDING_FLAG column comment matches the required format."""
    print_color("[VERIFY] Checking OUTSTANDING_FLAG column comment...", "cyan")
    expected_comment = "0=Paid, 1=Outstanding"
    actual_comment = comment.strip() if comment else ""

    if actual_comment == expected_comment:
        print_color("[PASS] OUTSTANDING_FLAG comment matches expected format", "green")
        print_color(f"  - Expected: '{expected_comment}'", "blue")
        print_color(f"  - Actual: '{actual_comment}'", "blue")
        return True
    else:
        print_color("[FAIL] OUTSTANDING_FLAG comment does not match expected format", "red")
        print_color(f"  - Expected: '{expected_comment}'", "blue")
        print_color(f"  - Actual: '{actual_comment}'", "blue")
        return False


async def run(groundtruth_file: str) -> bool:
    print_color("DB VERIFICATION START", "cyan")
    print_color("=" * 60, "cyan")
    print_color(f"Timestamp: {datetime.now()}", "blue")

    gt_records, gt_ids, interference_ids, inter_pay_map = load_inputs(groundtruth_file)
    if not gt_ids:
        print_color("[FAIL] No groundtruth invoices loaded", "red")
        return False

    # Display database type
    if use_local_database():
        data_dir = os.getenv('SNOWFLAKE_DATA_DIR')
        print_color(f"Using Local Snowflake Database: {data_dir}", "cyan")
    else:
        print_color("Using Remote Snowflake Python connector", "cyan")

    rows = await db_fetch_invoice_rows()
    if not rows:
        print_color("[FAIL] No rows fetched from database", "red")
        return False

    payments_rows = await db_fetch_payment_rows()
    if not payments_rows:
        print_color("[FAIL] No payment rows fetched from database", "red")
        return False

    ok_ids = verify_ids(gt_ids, interference_ids, rows)
    ok_pay = verify_payments(inter_pay_map, payments_rows, gt_records)

    # Check OUTSTANDING_FLAG column comment
    comment = await db_check_outstanding_flag_comment()
    ok_comment = verify_outstanding_flag_comment(comment)

    return ok_ids and ok_pay and ok_comment


def main(groundtruth_file: str = "./groundtruth_workspace/invoice.jsonl") -> bool:
    try:
        return asyncio.run(run(groundtruth_file))
    except Exception as e:
        print_color(f"[ERROR] Unexpected exception: {e}", "red")
        return False


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)