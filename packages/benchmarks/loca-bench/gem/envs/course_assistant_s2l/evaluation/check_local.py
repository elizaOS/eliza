#!/usr/bin/env python3
"""
Email Content Check Script - Course Assistant Task Evaluation

Check objectives:
- Check if enrolled students who haven't submitted assignments received reminder emails
- Email subject must be "nlp-course-emergency"
- Email content must include student's name and student ID

Evaluation criteria:
1. ✅ Each student receives exactly 1 qualifying email
2. ✅ Email subject is correct
3. ✅ Email content includes student name and student ID
4. ❌ Should not have extra emails with same subject but non-matching content
"""

import os
import sys
import re
from pathlib import Path
from typing import List, Tuple, Dict

current_dir = Path(__file__).parent
# Add mcp_convert path to import EmailDatabase
from mcp_convert.mcps.email.database_utils import EmailDatabase


def extract_email_body(email_dict: Dict) -> str:
    """Extract body from email dict (prefer body, fallback to html_body with tags removed)"""
    # Prefer plain text body
    body = email_dict.get('body', '')
    if body:
        return body

    # Fallback to html_body with HTML tags removed
    html_body = email_dict.get('html_body', '')
    if html_body:
        # Simple HTML tag removal
        clean_body = re.sub('<[^<]+?>', '', html_body)
        return clean_body

    return ''


def check_account_emails_db(db: EmailDatabase,
                            email_address: str,
                            password: str,
                            required_keywords: List[str],
                            account_label: str) -> Tuple[bool, Dict]:
    """Check nlp-course-emergency emails for specified account (using database)"""
    passed = True
    valid_mail_info = None

    try:
        # Login user
        try:
            db.login(email_address, password)
        except ValueError as e:
            print(f"❌ [{account_label}] Login failed: {e}")
            return False, None

        # Search for emails with subject nlp-course-emergency
        search_result = db.search_emails(query="nlp-course-emergency", folder="INBOX", page=1, page_size=100)
        emails = search_result.get('emails', [])

        if not emails:
            print(f"❌ [{account_label}] No emails found with subject nlp-course-emergency")
            db.logout()
            return False, None

        valid_count = 0
        extra_msgs = []

        for email_data in emails:
            subject = email_data.get('subject', 'Unknown Subject')
            sender = email_data.get('from', 'Unknown Sender')
            body = extract_email_body(email_data)

            # Check all keywords
            if all(kw in body for kw in required_keywords):
                valid_count += 1
                valid_mail_info = {
                    'account': account_label,
                    'subject': subject,
                    'sender': sender,
                    'body': body
                }
            else:
                snippet = body[:60].replace('\n', ' ').replace('\r', ' ')
                extra_msgs.append(f"Subject: {subject} | Sender: {sender} | Body snippet: {snippet}")

        # Validate results
        if valid_count == 0:
            print(f"❌ [{account_label}] No emails found with body containing all keywords ({required_keywords})")
            passed = False
        elif valid_count > 1:
            print(f"❌ [{account_label}] Found {valid_count} emails with body containing all keywords ({required_keywords}), should be only 1")
            passed = False

        if extra_msgs:
            print(f"❌ [{account_label}] Found {len(extra_msgs)} extra emails with subject nlp-course-emergency but non-matching body:")
            for msg in extra_msgs:
                print(f"   • {msg}")
            passed = False

        if passed:
            print(f"✅ [{account_label}] Email check passed")

        db.logout()

    except Exception as e:
        print(f"❌ [{account_label}] Exception occurred during check: {e}")
        import traceback
        traceback.print_exc()
        passed = False

    return passed, valid_mail_info


def load_students_from_config(config_dir: Path) -> Tuple[List[Dict], List[Dict], List[Dict]]:
    """Load student information from configuration files

    Returns:
        (Non-submitted enrolled students, Submitted students, Dropped students)
    """
    import json

    # Read Excel file from initial_workspace
    excel_path = config_dir / "initial_workspace" / "nlp_statistics.xlsx"
    if not excel_path.exists():
        print(f"❌ Excel file does not exist: {excel_path}")
        return [], [], []

    # Read emails.jsonl from files to get submitted students
    emails_jsonl = config_dir / "files" / "emails.jsonl"
    submitted_student_ids = set()
    if emails_jsonl.exists():
        with open(emails_jsonl, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    email_data = json.loads(line)
                    # Extract student ID from subject: nlp-presentation-{student_id}-{name}
                    subject = email_data.get('subject', '')
                    import re
                    match = re.search(r'nlp-presentation-(\d+)-', subject)
                    if match:
                        submitted_student_ids.add(match.group(1))
                except:
                    continue

    # Read Excel file
    try:
        from openpyxl import load_workbook
    except ImportError:
        print("❌ Error: openpyxl not installed")
        return [], [], []

    wb = load_workbook(excel_path)
    ws = wb.active

    all_students = []
    for row in ws.iter_rows(min_row=2, values_only=True):  # Skip header
        if not row[0]:  # If name is empty, skip
            continue
        student = {
            'name': row[0],
            'student_id': str(row[1]),
            'email': row[2],
            'status': row[3]
        }
        all_students.append(student)

    # Categorize students
    not_submitted_enrolled = []  # Non-submitted enrolled students
    submitted_students = []       # Submitted students
    dropped_students = []         # Dropped students

    for student in all_students:
        if student['status'] == 'dropped':
            dropped_students.append(student)
        elif student['student_id'] in submitted_student_ids:
            submitted_students.append(student)
        else:
            not_submitted_enrolled.append(student)

    return not_submitted_enrolled, submitted_students, dropped_students


def main():
    """
    Evaluation function - Check if enrolled students who haven't submitted assignments received reminder emails

    Check logic:
    1. Check all enrolled students who haven't submitted received reminder emails
    2. Email subject must be "nlp-course-emergency"
    3. Email content must include student's name and student ID
    4. Ensure students who have submitted and dropped students did not receive emails

    Notes:
    - Dropped students (status="dropped") should not receive emails
    - Students who have submitted should not receive emails
    """

    # Initialize EmailDatabase
    # Try to get database directory from environment variable
    email_db_dir = os.environ.get('EMAIL_DATA_DIR')


    print(f"📂 Email database directory: {email_db_dir}")

    try:
        db = EmailDatabase(data_dir=email_db_dir)
    except Exception as e:
        print(f"❌ Unable to initialize EmailDatabase: {e}")
        return 0

    # Load student configuration
    # Prefer task_dir from environment variable (support multi-instance running, avoid conflicts)
    task_dir_str = os.environ.get('TASK_DIR')
    if task_dir_str:
        # Use task directory specified by environment variable (each instance independent)
        task_dir = Path(task_dir_str)
    else:
        # Fallback to path based on script location (compatible with old calling method)
        task_dir = current_dir.parent

    not_submitted, submitted, dropped = load_students_from_config(task_dir)

    print(f"\n📊 Student statistics:")
    print(f"   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   Enrolled students who haven't submitted: {len(not_submitted)} (should receive email)")
    print(f"   Students who have submitted: {len(submitted)} (should not receive email)")
    print(f"   Dropped students: {len(dropped)} (should not receive email)")
    print(f"   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

    if not not_submitted:
        print("❌ Error: No enrolled students who haven't submitted found")
        return 0

    # Check all enrolled students who haven't submitted
    all_passed = True
    valid_mails = []

    print("=" * 60)
    print("🔍 Checking if enrolled students who haven't submitted received reminder emails...")
    print("=" * 60)

    for student in not_submitted:
        student_name = student['name']
        student_email = student['email']
        student_id = student['student_id']

        # Since we don't store all student passwords, need to get from database users
        user_info = db.users.get(student_email)
        if not user_info:
            print(f"\n❌ Student {student_name} ({student_email}) does not exist in database")
            all_passed = False
            continue

        password = user_info.get('password', '')

        print(f"\n📧 Checking student {student_name}'s inbox: {student_email}")
        print(f"🔍 Checking if student {student_name} received reminder email...")
        
        passed, valid_mail_info = check_account_emails_db(
            db,
            student_email,
            password,
            [student_name, student_id],
            student_name
        )
        
        if valid_mail_info:
            valid_mails.append(valid_mail_info)
        if not passed:
            all_passed = False
    
    print("\n" + "=" * 60)
    print(f"📊 Check results summary")
    print("=" * 60)
    print(f"   Students who should receive email: {len(not_submitted)}")
    print(f"   Students who actually received email: {len(valid_mails)}")
    print("=" * 60 + "\n")

    if all_passed:
        print("\n🎉 All account email checks passed!\n")
        print("====== Qualifying email content ======")
        for mail in valid_mails:
            print(f"Account: {mail['account']}")
            print(f"Sender: {mail['sender']}")
            print(f"Subject: {mail['subject']}")
            print(f"Body:\n{mail['body']}\n")
            print("------------------------")
        print("========================\n")
    else:
        print("\n💥 Email check failed!")
        print("⚠️  The following students should have received email but did not pass check:")
        for student in not_submitted:
            found = any(mail['account'] == student['name'] for mail in valid_mails)
            if not found:
                print(f"   • {student['name']} ({student['email']})")

    return 1 if all_passed else 0

if __name__ == '__main__':
    exit(main())
