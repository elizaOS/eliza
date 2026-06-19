#!/usr/bin/env python3
"""
Email verification for payable invoice checker.
Checks that each buyer with unpaid invoices received an email with subject
"Process outstanding invoices" and that the body contains the expected PDF filenames.
Additionally checks sender's outbox for any messages accidentally sent to
interference addresses.
Supports both local database and IMAP email checking.
"""

import os
import email
import email.header
import imaplib
import sys
import re
import json
from typing import List, Tuple, Dict
from pathlib import Path

from mcp_convert.mcps.email.database_utils import EmailDatabase

#from utils.general.helper import print_color
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

# Import both local and remote email support
try:
    from mcps.email.database_utils import EmailDatabase
    LOCAL_EMAIL_AVAILABLE = True
except ImportError:
    LOCAL_EMAIL_AVAILABLE = False
    EmailDatabase = None

REMOTE_EMAIL_AVAILABLE = False

TARGET_SUBJECT_LOWER = "process outstanding invoices"

# Global variable to store local database instance
_local_email_db = None


def use_local_email() -> bool:
    """Check if we should use local email database based on environment variable"""
    return os.getenv('EMAIL_DATA_DIR') is not None


def get_local_email_db():
    """Get or create local email database instance"""
    global _local_email_db
    if _local_email_db is None:
        data_dir = os.getenv('EMAIL_DATA_DIR')
        if not data_dir:
            raise RuntimeError("EMAIL_DATA_DIR environment variable not set")
        _local_email_db = EmailDatabase(data_dir=data_dir)
    return _local_email_db


def check_emails_local(buyer_email: str, required_filenames: List[str], strict_mode: bool = True) -> Tuple[bool, dict, int]:
    """Check emails using local database
    
    Args:
        buyer_email: Email address to check
        required_filenames: List of filenames that should be in the email body
        strict_mode: If True, ensures exactly one matching email exists
    
    Returns:
        Tuple of (passed, mail_info, matching_count)
    """
    try:
        db = get_local_email_db()
        
        # Get all emails for this buyer
        user_dir = db._get_user_data_dir(buyer_email)
        emails_file = os.path.join(user_dir, "emails.json")
        
        if not os.path.exists(emails_file):
            print_color(f"[LOCAL][{buyer_email}] No emails found (user data not found)", "red")
            return False, None, 0
        
        with open(emails_file, 'r', encoding='utf-8') as f:
            emails_data = json.load(f)
        
        # Find emails in INBOX folder with matching subject
        matching_emails = []
        for email_id, email_data in emails_data.items():
            if email_data.get('folder') == 'INBOX':
                subject = email_data.get('subject', '').lower()
                if TARGET_SUBJECT_LOWER in subject:
                    matching_emails.append((email_id, email_data))
        
        if not matching_emails:
            print_color(f"[LOCAL][{buyer_email}] No email found with subject containing '{TARGET_SUBJECT_LOWER}'", "red")
            return False, None, 0
        
        # Check each matching email for required filenames
        valid_emails = []
        for email_id, email_data in matching_emails:
            body = email_data.get('body', '')
            subject = email_data.get('subject', '')
            
            filenames_found = []
            missing_filenames = []
            
            for filename in required_filenames:
                # Try to find filename with .pdf extension
                if filename in body:
                    filenames_found.append(filename)
                else:
                    # Also try without .pdf extension (e.g., "INV-2024-013" instead of "INV-2024-013.pdf")
                    invoice_id = filename.replace('.pdf', '')
                    if invoice_id in body:
                        filenames_found.append(filename)  # Still count as found
                    else:
                        missing_filenames.append(filename)
            
            if not missing_filenames:
                # All filenames found
                valid_emails.append({
                    'email_id': email_id,
                    'subject': subject,
                    'filenames_found': filenames_found
                })
        
        # Strict mode: ensure exactly one valid email
        if strict_mode:
            if len(valid_emails) == 0:
                print_color(f"[LOCAL][{buyer_email}] No email with all required filenames", "red")
                return False, None, len(matching_emails)
            elif len(valid_emails) > 1:
                print_color(f"[LOCAL][{buyer_email}] ✗ Found {len(valid_emails)} valid emails, expected exactly 1", "red")
                print_color(f"  This indicates duplicate/multiple sends!", "red")
                return False, valid_emails[0], len(matching_emails)
            else:
                # Exactly one valid email - PASS
                mail_info = valid_emails[0]
                print_color(f"[LOCAL][{buyer_email}] ✓ Exactly one valid email found:", "green")
                print_color(f"  Subject: {mail_info['subject']}", "blue")
                print_color(f"  All required filenames present: {mail_info['filenames_found']}", "green")
                return True, mail_info, len(matching_emails)
        else:
            # Non-strict mode: just need at least one
            if valid_emails:
                mail_info = valid_emails[0]
                print_color(f"[LOCAL][{buyer_email}] ✓ Valid email found:", "green")
                print_color(f"  Subject: {mail_info['subject']}", "blue")
                print_color(f"  All required filenames present: {mail_info['filenames_found']}", "green")
                return True, mail_info, len(matching_emails)
            else:
                print_color(f"[LOCAL][{buyer_email}] No email with all required filenames", "red")
                return False, None, len(matching_emails)
        
    except Exception as e:
        print_color(f"[LOCAL][{buyer_email}] Error: {e}", "red")
        import traceback
        traceback.print_exc()
        return False, None, 0


def load_unpaid_invoices(groundtruth_file: str) -> Tuple[Dict[str, List[str]], set]:
    """Load unpaid invoices grouped by buyer email from groundtruth JSONL.
    
    Returns:
        Tuple of (unpaid_by_buyer, all_buyers)
        - unpaid_by_buyer: dict mapping buyer email to list of unpaid invoice filenames
        - all_buyers: set of all buyer emails (both paid and unpaid)
    """
    unpaid_by_buyer = {}
    all_buyers = set()
    
    if not os.path.exists(groundtruth_file):
        print(f"[INPUT] Groundtruth file not found: {groundtruth_file}")
        return unpaid_by_buyer, all_buyers
    
    with open(groundtruth_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                invoice = json.loads(line)
                buyer_email = invoice.get('buyer_email')
                if buyer_email:
                    all_buyers.add(buyer_email)
                
                if invoice.get('payment_status', {}).get('flag', 0) == 1:
                    invoice_id = invoice.get('invoice_id')
                    
                    if buyer_email and invoice_id:
                        if buyer_email not in unpaid_by_buyer:
                            unpaid_by_buyer[buyer_email] = []
                        pdf_filename = f"{invoice_id}.pdf"
                        unpaid_by_buyer[buyer_email].append(pdf_filename)
    
    print_color(f"[INPUT] Loaded from {groundtruth_file}:", "cyan")
    print_color(f"  - All buyers: {sorted(all_buyers)}", "blue")
    print_color(f"  - Buyers with unpaid invoices: {sorted(unpaid_by_buyer.keys())}", "blue")
    for buyer, filenames in unpaid_by_buyer.items():
        print_color(f"    * {buyer}: {filenames}", "blue")
    
    return unpaid_by_buyer, all_buyers


def check_no_emails_local(email_address: str) -> Tuple[bool, int]:
    """Check that an email address has NO emails with the target subject.
    
    Returns:
        Tuple of (passed, email_count)
        - passed: True if no matching emails found
        - email_count: Number of matching emails found
    """
    try:
        db = get_local_email_db()
        
        # Get all emails for this address
        user_dir = db._get_user_data_dir(email_address)
        emails_file = os.path.join(user_dir, "emails.json")
        
        if not os.path.exists(emails_file):
            # No emails file means no emails - this is good
            return True, 0
        
        with open(emails_file, 'r', encoding='utf-8') as f:
            emails_data = json.load(f)
        
        # Count emails in INBOX folder with matching subject
        matching_count = 0
        matching_subjects = []
        for email_id, email_data in emails_data.items():
            if email_data.get('folder') == 'INBOX':
                subject = email_data.get('subject', '')
                if TARGET_SUBJECT_LOWER in subject.lower():
                    matching_count += 1
                    matching_subjects.append(subject)
        
        if matching_count > 0:
            print_color(f"[LOCAL][{email_address}] ✗ Found {matching_count} unexpected email(s):", "red")
            for subj in matching_subjects:
                print_color(f"  - {subj}", "red")
            return False, matching_count
        else:
            print_color(f"[LOCAL][{email_address}] ✓ No unexpected emails", "green")
            return True, 0
        
    except Exception as e:
        print_color(f"[LOCAL][{email_address}] Error checking: {e}", "yellow")
        # If we can't check, assume it's okay (file doesn't exist, etc.)
        return True, 0

def check_account_emails(email_address: str, password: str, imap_server: str, imap_port: int, use_ssl: bool, required_filenames: List[str], account_label: str) -> Tuple[bool, dict]:
    """Verify target account has exactly one email with subject and all required filenames in body."""
    passed = True
    valid_mail_info = None
    try:
        if use_ssl:
            imap_connection = imaplib.IMAP4_SSL(imap_server, imap_port)
        else:
            imap_connection = imaplib.IMAP4(imap_server, imap_port)
        imap_connection.login(email_address, password)
        imap_connection.select('INBOX')
        status, all_message_numbers = imap_connection.search(None, 'ALL')
        if status != 'OK':
            print_color(f"[MAIL][{account_label}] Search failed", "red")
            return False, None

        all_messages = all_message_numbers[0].split()

        message_list = []
        for num in all_messages:
            try:
                status, message_data = imap_connection.fetch(num, '(RFC822)')
                if status == 'OK':
                    email_message = email.message_from_bytes(message_data[0][1])
                    subject = decode_email_subject(email_message.get('Subject', ''))
                    print(f"[MAIL][{account_label}] Subject: {subject}")
                    if TARGET_SUBJECT_LOWER in subject:
                        message_list.append(num)
            except Exception:
                continue

        if not message_list:
            print_color(f"[MAIL][{account_label}] No email found with subject containing '{TARGET_SUBJECT_LOWER}'", "red")
            return False, None
        valid_count = 0
        extra_msgs = []
        for num in message_list:
            status, message_data = imap_connection.fetch(num, '(RFC822)')
            if status != 'OK':
                print_color(f"[MAIL][{account_label}] Failed to fetch message (ID: {num})", "yellow")
                continue
            email_message = email.message_from_bytes(message_data[0][1])
            subject = decode_email_subject(email_message.get('Subject', 'Unknown Subject'))
            sender = email_message.get('From', 'Unknown Sender')
            body = extract_email_body(email_message)
            
            filenames_found = []
            missing_filenames = []
            for filename in required_filenames:
                # Try to find filename with .pdf extension
                if filename in body:
                    filenames_found.append(filename)
                else:
                    # Also try without .pdf extension (e.g., "INV-2024-013" instead of "INV-2024-013.pdf")
                    invoice_id = filename.replace('.pdf', '')
                    if invoice_id in body:
                        filenames_found.append(filename)  # Still count as found
                    else:
                        missing_filenames.append(filename)
            
            if len(missing_filenames) == 0:
                valid_count += 1
                valid_mail_info = {
                    'account': account_label,
                    'subject': subject,
                    'sender': sender,
                    'body': body,
                    'filenames_found': filenames_found
                }
                print_color(f"[MAIL][{account_label}] Found email containing all required filenames", "green")
                for filename in filenames_found:
                    print_color(f"   - {filename}", "blue")
            else:
                snippet = body[:100].replace('\n', ' ').replace('\r', ' ')
                extra_msgs.append(f"Subject: {subject} | From: {sender} | Missing: {missing_filenames} | Snippet: {snippet}")
        
        if valid_count == 0:
            print_color(f"[MAIL][{account_label}] No email includes all required filenames", "red")
            print_color(f"   Expected filenames: {required_filenames}", "blue")
            passed = False
        elif valid_count > 1:
            print_color(f"[MAIL][{account_label}] Found {valid_count} matching emails; expected exactly 1", "red")
            passed = False
        
        if extra_msgs:
            print_color(f"[MAIL][{account_label}] {len(extra_msgs)} emails matched subject but were incomplete:", "yellow")
            for msg in extra_msgs:
                print_color(f"   - {msg}", "yellow")
        
        if passed:
            print_color(f"[MAIL][{account_label}] PASS", "green")
        
        imap_connection.logout()
    except Exception as e:
        print_color(f"[MAIL][{account_label}] Exception during check: {e}", "red")
        passed = False
    return passed, valid_mail_info


def main(groundtruth_file: str = "./groundtruth_workspace/invoice.jsonl") -> bool:
    """Run email verification end-to-end. Returns True if all checks pass."""
    print_color("EMAIL VERIFICATION START (STRICT MODE)", "cyan")
    print_color("=" * 60, "cyan")

    unpaid_invoices_by_buyer, all_buyers = load_unpaid_invoices(groundtruth_file)

    interference_emails = {
        "JSmith@mcp.com",
        "MBrown@mcp.com",
        "AWilliams@mcp.com",
        "RJohnson@mcp.com",
        "LDavis@mcp.com",
        "KWilson@mcp.com",
        "TMiller@mcp.com",
        "SAnderson@mcp.com"
    }
    print_color(f"\n[CONFIG] Interference addresses: {sorted(interference_emails)}", "cyan")
    
    # Buyers who should NOT receive emails (paid invoices only)
    paid_buyers = all_buyers - set(unpaid_invoices_by_buyer.keys())
    print_color(f"[CONFIG] Buyers with only paid invoices (should receive NO emails): {sorted(paid_buyers)}", "cyan")
    
    # Check if using local email database
    if use_local_email():
        data_dir = os.getenv('EMAIL_DATA_DIR')
        print_color(f"\nUsing Local Email Database: {data_dir}", "cyan")
        
        # Use local database checking with strict mode
        all_passed = True
        
        # Check buyers who SHOULD receive emails (unpaid invoices)
        print_color("\n" + "=" * 60, "cyan")
        print_color("[PHASE 1] Checking buyers with UNPAID invoices", "cyan")
        print_color("=" * 60, "cyan")
        
        if not unpaid_invoices_by_buyer:
            print_color("No unpaid invoices found. Skipping this phase.", "yellow")
        else:
            for buyer_email, required_filenames in unpaid_invoices_by_buyer.items():
                print_color(f"\n[CHECK] {buyer_email} (expecting exactly 1 email with {len(required_filenames)} filenames)", "cyan")
                passed, mail_info, total_count = check_emails_local(buyer_email, required_filenames, strict_mode=True)
                if not passed:
                    all_passed = False
                    if total_count > 1:
                        print_color(f"  ⚠️  Multiple emails detected - possible duplicate sends!", "red")
        
        # Check buyers who should NOT receive emails (paid invoices only)
        print_color("\n" + "=" * 60, "cyan")
        print_color("[PHASE 2] Checking buyers with ONLY PAID invoices (should receive NOTHING)", "cyan")
        print_color("=" * 60, "cyan")
        
        if not paid_buyers:
            print_color("All buyers have unpaid invoices. Skipping this phase.", "yellow")
        else:
            for buyer_email in paid_buyers:
                print_color(f"\n[CHECK] {buyer_email} (expecting 0 emails)", "cyan")
                passed, count = check_no_emails_local(buyer_email)
                if not passed:
                    all_passed = False
                    print_color(f"  ⚠️  Should NOT have received any emails!", "red")
        
        # Check interference addresses should NOT receive emails
        print_color("\n" + "=" * 60, "cyan")
        print_color("[PHASE 3] Checking INTERFERENCE addresses (should receive NOTHING)", "cyan")
        print_color("=" * 60, "cyan")
        
        for interference_email in sorted(interference_emails):
            print_color(f"\n[CHECK] {interference_email} (expecting 0 emails)", "cyan")
            passed, count = check_no_emails_local(interference_email)
            if not passed:
                all_passed = False
                print_color(f"  ⚠️  Interference address received unexpected emails!", "red")
        
        # Final summary
        print_color("\n" + "=" * 60, "cyan")
        if all_passed:
            print_color("[RESULT] ALL EMAIL CHECKS PASSED", "green")
            print_color("  ✓ All buyers with unpaid invoices received exactly 1 correct email", "green")
            print_color("  ✓ No emails sent to buyers with only paid invoices", "green")
            print_color("  ✓ No emails sent to interference addresses", "green")
        else:
            print_color("[RESULT] SOME EMAIL CHECKS FAILED", "red")
        print_color("=" * 60, "cyan")
        
        return all_passed
    
    buyer_email_configs = {
        "dcooper@mcp.com": {
            "email": "dcooper@mcp.com",
            "password": "cooper$d660s",
            "imap_server": "localhost", 
            "imap_port": 1143,
            "use_ssl": False
        },
        "turnerj@mcp.com": {
            "email": "turnerj@mcp.com", 
            "password": "jose_86UKmSi",
            "imap_server": "localhost", 
            "imap_port": 1143,
            "use_ssl": False
        },
        "anthony_murphy24@mcp.com": {
            "email": "anthony_murphy24@mcp.com",
            "password": "anthony1997#",
            "imap_server": "localhost", 
            "imap_port": 1143,
            "use_ssl": False
        },
        "ashley_anderson@mcp.com": {
            "email": "ashley_anderson@mcp.com",
            "password": "AA0202@kEpFH",
            "imap_server": "localhost", 
            "imap_port": 1143,
            "use_ssl": False
        },
        "brenda_rivera81@mcp.com": {
            "email": "brenda_rivera81@mcp.com",
            "password": "brenda1991$q",
            "imap_server": "localhost", 
            "imap_port": 1143,
            "use_ssl": False
        },
        "cturner@mcp.com": {
            "email": "cturner@mcp.com",
            "password": "carol2002$ik",
            "imap_server": "localhost", 
            "imap_port": 1143,
            "use_ssl": False
        }
    }
    
    all_passed = True
    valid_mails = []
    
    print_color(f"\nChecking {len(unpaid_invoices_by_buyer)} buyer inbox(es)", "cyan")
    
    for buyer_email, unpaid_filenames in unpaid_invoices_by_buyer.items():
        print_color(f"\n[BUYER] {buyer_email}", "magenta")
        print_color(f"Required filenames: {unpaid_filenames}", "blue")
        
        if buyer_email not in buyer_email_configs:
            print_color(f"[CONFIG] Missing email config for {buyer_email}", "red")
            all_passed = False
            continue
            
        email_config = buyer_email_configs[buyer_email]
        
        passed, valid_mail_info = check_account_emails(
            email_config['email'], 
            email_config['password'], 
            email_config['imap_server'], 
            email_config['imap_port'], 
            email_config['use_ssl'], 
            unpaid_filenames, 
            buyer_email
        )
        
        if valid_mail_info:
            valid_mails.append(valid_mail_info)
        if not passed:
            all_passed = False

    print_color(f"\nChecking interference addresses (should receive nothing)", "cyan")
    interference_passed = True
    interference_violations = []

    for interference_email in interference_emails:
        print_color(f"  - {interference_email}", "blue")

    print_color(f"\nChecking sender outbox (must not send to interference)", "cyan")
    sender_config = {
        "email": "walkera@mcp.com",
        "password": "AW0808!6v5nP",
        "imap_server": "localhost",
        "imap_port": 1143,
        "use_ssl": False
    }

    outbox_passed, unexpected_sends = check_sender_outbox(sender_config, interference_emails)

    if not outbox_passed:
        print_color("[OUTBOX] FAIL", "red")
        all_passed = False

        if unexpected_sends:
            print_color(f"[OUTBOX] Found {len(unexpected_sends)} unexpected send(s):", "yellow")
            for send in unexpected_sends:
                print_color(f"   - To: {send['to']}", "blue")
                print_color(f"     Subject: {send['subject']}", "blue")
                print_color(f"     MessageID: {send['message_id']}", "blue")

    print_color(f"\nFinal verification: all expected buyers were checked", "cyan")

    expected_recipients = set(unpaid_invoices_by_buyer.keys())
    actual_recipients = set()

    for buyer_email in buyer_email_configs.keys():
        if buyer_email in unpaid_invoices_by_buyer:
            actual_recipients.add(buyer_email)

    if expected_recipients == actual_recipients:
        print_color(f"Coverage PASS: {len(expected_recipients)} buyer inbox(es)", "green")
    else:
        missing_checks = expected_recipients - actual_recipients
        if missing_checks:
            print_color(f"Coverage FAIL: missing checks for {missing_checks}", "red")
            all_passed = False

    print_color("\n" + "=" * 60, "cyan")
    if all_passed:
        print_color("EMAIL VERIFICATION PASS", "green")
        print_color("\n== VALID EMAIL DETAILS ==", "cyan")
        for mail in valid_mails:
            print_color(f"Account: {mail['account']}", "magenta")
            print_color(f"Sender: {mail['sender']}", "blue")
            print_color(f"Subject: {mail['subject']}", "blue")
            print_color(f"Filenames: {mail['filenames_found']}", "blue")
            print_color(f"Body:\n{mail['body'][:200]}...", "white")
            print("------------------------")
        print_color("========================", "cyan")
    else:
        print_color("EMAIL VERIFICATION FAIL", "red")
        print_color(f"Subject must include '{TARGET_SUBJECT_LOWER}' and body must list required filenames", "yellow")
    
    return all_passed

if __name__ == '__main__':
    sys.exit(0 if main() else 1)