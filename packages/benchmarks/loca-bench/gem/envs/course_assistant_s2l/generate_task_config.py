#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Course Assistant Task Configuration Generator
Dynamically generates task configurations of varying difficulty, including:
- Excel student roster
- Email submission records
- Evaluation configuration
"""

import json
import random
from pathlib import Path
from typing import List, Dict, Any, Tuple
import argparse


class CourseAssistantConfigGenerator:
    """Course Assistant Task Configuration Generator"""
    
    # English name pool (50 first names × 45 last names = 2250 unique combinations)
    FIRST_NAMES = [
        # Male names
        "James", "John", "Robert", "Michael", "William",
        "David", "Richard", "Joseph", "Thomas", "Christopher",
        "Daniel", "Matthew", "Anthony", "Mark", "Donald",
        "Steven", "Paul", "Andrew", "Joshua", "Kenneth",
        "Kevin", "Brian", "George", "Timothy", "Ronald",
        # Female names
        "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth",
        "Barbara", "Susan", "Jessica", "Sarah", "Karen",
        "Emma", "Olivia", "Ava", "Isabella", "Sophia",
        "Mia", "Charlotte", "Amelia", "Harper", "Evelyn",
        "Abigail", "Emily", "Madison", "Chloe", "Grace"
    ]

    LAST_NAMES = [
        "Smith", "Johnson", "Williams", "Brown", "Jones",
        "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
        "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
        "Thomas", "Taylor", "Moore", "Jackson", "Martin",
        "Lee", "Thompson", "White", "Harris", "Sanchez",
        "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
        "Young", "Allen", "King", "Wright", "Scott",
        "Torres", "Nguyen", "Hill", "Flores", "Green",
        "Adams", "Nelson", "Baker", "Hall", "Rivera"
    ]
    
    # NLP topic content templates
    NLP_TOPICS = [
        "Recent years have witnessed remarkable progress in Natural Language Processing. Large models like the GPT series have pushed the boundaries of language understanding and generation, paving the way for breakthroughs in multimodal, cross-lingual, and human-machine collaboration domains.",
        "NLP technology is gradually permeating every aspect of life. From intelligent customer service to automatic translation, NLP makes communication between humans and machines more natural. In the future, NLP is expected to achieve deeper semantic understanding.",
        "I believe the future of NLP lies in deep integration with knowledge graphs, reasoning, and other technologies. Only by understanding the knowledge behind language can NLP truly achieve intelligence.",
        "With the development of deep learning, the capabilities of NLP models continue to strengthen. In the future, NLP will focus more on model interpretability and fairness, promoting healthy technological development.",
        "The development of NLP has greatly facilitated information acquisition and knowledge management. In the future, NLP will play a greater role in education, healthcare, and other fields, contributing to social progress.",
        "I am full of expectations for the future of NLP. With the popularization of multilingual models, global information barriers will be further broken down, promoting cultural exchange and understanding.",
        "NLP is not just technology, but a bridge connecting people and the world. In the future, NLP will empower more innovative applications and improve human quality of life.",
        "With the development of pre-trained models and transfer learning, the application threshold of NLP has been greatly lowered. In the future, NLP will become more inclusive, serving a wider range of people.",
        "NLP's progress enables machines to better understand human emotions and intentions. In the future, affective computing and personalized dialogue will become important directions for NLP.",
        "I think the challenge of NLP lies in how to handle complex contexts and implicit semantics. In the future, NLP models will pay more attention to context and reasoning capabilities.",
        "The development of NLP technology has promoted the popularity of applications such as intelligent assistants and automatic summarization. In the future, NLP will show greater potential in cross-domain knowledge integration.",
        "AGI is coming soon. The development of NLP technology has promoted the popularity of applications such as intelligent assistants and automatic summarization. In the future, NLP will show greater potential in cross-domain knowledge integration.",
        "Natural Language Processing represents the intersection of linguistics and artificial intelligence. As transformers revolutionize the field, we're witnessing unprecedented advances in machine understanding of human language.",
        "The evolution of attention mechanisms has fundamentally changed how we approach sequence-to-sequence tasks. Future NLP systems will likely integrate symbolic reasoning with neural approaches.",
        "Transfer learning and few-shot learning are democratizing NLP, allowing smaller organizations to leverage powerful language models. This trend will accelerate innovation across industries."
    ]
    
    def __init__(self, seed: int = 42):
        """Initialize generator"""
        random.seed(seed)
    
    def generate_student_id(self, year_prefix: int = 2000) -> str:
        """Generate student ID"""
        suffix = random.randint(10000, 99999)
        return f"{year_prefix}{suffix}"
    
    def generate_students(self, num_students: int, dropout_probability: float = 0.1) -> List[Dict[str, Any]]:
        """Generate student list

        Args:
            num_students: Total number of students
            dropout_probability: Dropout probability

        Returns:
            Student list, each student contains: name, student_id, email, status
        """
        students = []
        used_ids = set()
        used_names = set()

        for i in range(num_students):
            # Generate unique name
            while True:
                first_name = random.choice(self.FIRST_NAMES)
                last_name = random.choice(self.LAST_NAMES)
                full_name = f"{first_name} {last_name}"
                if full_name not in used_names:
                    used_names.add(full_name)
                    break

            # Generate unique student ID
            while True:
                student_id = self.generate_student_id()
                if student_id not in used_ids:
                    used_ids.add(student_id)
                    break

            # Generate email
            email_username = f"{first_name.lower()}{last_name.lower()}{random.randint(1, 99)}"
            email = f"{email_username}@mcp.com"

            # Generate password
            password = ''.join(random.choices('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$', k=12))

            # Decide whether to drop
            status = "dropped" if random.random() < dropout_probability else "enrolled"
            
            students.append({
                "name": full_name,
                "student_id": student_id,
                "email": email,
                "password": password,
                "status": status
            })
        
        return students
    
    def select_submitted_students(self,
                                   students: List[Dict],
                                   submission_rate: float) -> Tuple[List[Dict], List[Dict]]:
        """Select students who have submitted assignments

        Args:
            students: Student list
            submission_rate: Submission rate (0-1)

        Returns:
            (List of submitted students, List of non-submitted students)
        """
        # Only consider enrolled students
        enrolled_students = [s for s in students if s["status"] == "enrolled"]

        # Calculate number of submissions
        num_submitted = int(len(enrolled_students) * submission_rate)

        # Randomly select submitted students
        submitted = random.sample(enrolled_students, num_submitted)
        submitted_ids = {s["student_id"] for s in submitted}

        # Students who haven't submitted
        not_submitted = [s for s in enrolled_students if s["student_id"] not in submitted_ids]

        return submitted, not_submitted
    
    def generate_email_content(self, student: Dict) -> Dict[str, str]:
        """Generate student's email submission content"""
        content = random.choice(self.NLP_TOPICS)
        
        return {
            "sender_name": student["name"],
            "subject": f"nlp-presentation-{student['student_id']}-{student['name']}",
            "content": f"<html><body><p>{content}</p></body></html>",
            "content_type": "html"
        }
    
    def save_excel_file(self, students: List[Dict], output_path: Path):
        """Save student information to Excel file"""
        try:
            from openpyxl import Workbook
        except ImportError:
            print("❌ Error: openpyxl not installed, cannot create Excel file")
            print("💡 Please install with: pip install openpyxl")
            print("   Or using conda: conda install openpyxl")
            raise ImportError("openpyxl is required to create Excel files. Please install it with: pip install openpyxl")

        # Create Excel file
        wb = Workbook()
        ws = wb.active
        ws.title = "NLP Course Students"

        # Write header
        ws.append(["Name", "Student ID", "Email", "Status"])

        # Write student data
        for student in students:
            ws.append([
                student["name"],
                student["student_id"],
                student["email"],
                student["status"]
            ])

        # Save file
        output_path.parent.mkdir(parents=True, exist_ok=True)
        wb.save(output_path)
        print(f"✅ Saved: {output_path}")
    
    def save_emails_jsonl(self, submitted_students: List[Dict], output_path: Path):
        """Save email submission records to JSONL file"""
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, 'w', encoding='utf-8') as f:
            for student in submitted_students:
                email_data = self.generate_email_content(student)
                f.write(json.dumps(email_data, ensure_ascii=False) + '\n')

        print(f"✅ Saved: {output_path} ({len(submitted_students)} emails)")
    
    def save_students_info(self, students: List[Dict], output_path: Path):
        """Save complete student information (including passwords) to JSON file"""
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(students, f, ensure_ascii=False, indent=2)

        print(f"✅ Saved student info: {output_path} ({len(students)} students)")
    
    def save_evaluation_config(self,
                               not_submitted_students: List[Dict],
                               num_check_students: int,
                               output_dir: Path):
        """Save evaluation configuration

        The new version of the evaluation script automatically reads all student data
        from Excel and emails.jsonl, so no need to pre-generate student list.

        Important notes:
        - New version checks all enrolled students who haven't submitted
        - Dropped students and students who have submitted are automatically excluded
        """
        print(f"\n   Total non-submitted students: {len(not_submitted_students)}")
        print(f"   ✅ New evaluation script will check all non-submitted students")

        # Update evaluation check_local.py file
        eval_file = output_dir / "evaluation" / "check_local.py"

        # Read template
        template_path = Path(__file__).parent / "evaluation_template.py"
        if template_path.exists():
            with open(template_path, 'r', encoding='utf-8') as f:
                template = f.read()
        else:
            # If no template, use default template
            template = self.get_evaluation_template()

        eval_file.parent.mkdir(parents=True, exist_ok=True)
        with open(eval_file, 'w', encoding='utf-8') as f:
            f.write(template)

        print(f"✅ Updated: {eval_file}")
        print(f"   Will check all {len(not_submitted_students)} non-submitted students")

        return not_submitted_students
    
    def get_evaluation_template(self) -> str:
        """Return evaluation script template"""
        return '''#!/usr/bin/env python3
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
                snippet = body[:60].replace('\\n', ' ').replace('\\r', ' ')
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
                    match = re.search(r'nlp-presentation-(\\d+)-', subject)
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
    if not email_db_dir:
        # Fallback to default location
        email_db_dir = str(MCP_CONVERT_PATH / "mcps" / "email" / "data")

    # Load student configuration
    not_submitted, submitted, dropped = load_students_from_config(task_dir)

    print(f"\\n📊 Student statistics:")
    print(f"   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   Enrolled students who haven't submitted: {len(not_submitted)} (should receive email)")
    print(f"   Students who have submitted: {len(submitted)} (should not receive email)")
    print(f"   Dropped students: {len(dropped)} (should not receive email)")
    print(f"   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n")

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
            print(f"\\n❌ Student {student_name} ({student_email}) does not exist in database")
            all_passed = False
            continue

        password = user_info.get('password', '')

        print(f"\\n📧 Checking student {student_name}'s inbox: {student_email}")
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

    print("\\n" + "=" * 60)
    print(f"📊 Check results summary")
    print("=" * 60)
    print(f"   Students who should receive email: {len(not_submitted)}")
    print(f"   Students who actually received email: {len(valid_mails)}")
    print("=" * 60 + "\\n")

    if all_passed:
        print("\\n🎉 All account email checks passed!\\n")
        print("====== Qualifying email content ======")
        for mail in valid_mails:
            print(f"Account: {mail['account']}")
            print(f"Sender: {mail['sender']}")
            print(f"Subject: {mail['subject']}")
            print(f"Body:\\n{mail['body']}\\n")
            print("------------------------")
        print("========================\\n")
    else:
        print("\\n💥 Email check failed!")
        print("⚠️  The following students should have received email but did not pass check:")
        for student in not_submitted:
            found = any(mail['account'] == student['name'] for mail in valid_mails)
            if not found:
                print(f"   • {student['name']} ({student['email']})")

    return 1 if all_passed else 0

if __name__ == '__main__':
    exit(main())
'''
    
    def generate_config(self,
                       output_dir: Path,
                       num_students: int = 15,
                       dropout_rate: float = 0.1,
                       submission_rate: float = 0.7,
                       num_check_students: int = 2,
                       seed: int = None):
        """Generate complete task configuration

        Args:
            output_dir: Output directory
            num_students: Total number of students
            dropout_rate: Dropout rate (0-1)
            submission_rate: Submission rate (0-1)
            num_check_students: Number of students to check
            seed: Random seed
        """
        if seed is not None:
            random.seed(seed)

        print(f"🎲 Generating course assistant task configuration...")
        print(f"   Total students: {num_students}")
        print(f"   Dropout rate: {dropout_rate:.0%}")
        print(f"   Submission rate: {submission_rate:.0%}")
        print(f"   Check students count: {num_check_students}")

        # 1. Generate student list
        print(f"\n📝 Generating student roster...")
        students = self.generate_students(num_students, dropout_rate)

        enrolled_students = [s for s in students if s["status"] == "enrolled"]
        dropped_students = [s for s in students if s["status"] == "dropped"]

        print(f"   Total students: {num_students}")
        print(f"   Enrolled students: {len(enrolled_students)}")
        print(f"   Dropped students: {len(dropped_students)}")

        # 2. Select submitted students
        print(f"\n📧 Generating email submission records...")
        submitted, not_submitted = self.select_submitted_students(students, submission_rate)

        print(f"   Submitted: {len(submitted)}")
        print(f"   Not submitted: {len(not_submitted)}")

        # 3. Save Excel file
        excel_path = output_dir / "initial_workspace" / "nlp_statistics.xlsx"
        self.save_excel_file(students, excel_path)

        # 4. Save student info (including passwords) to JSON
        students_info_path = output_dir / "files" / "students_info.json"
        self.save_students_info(students, students_info_path)

        # 5. Save email JSONL file
        emails_path = output_dir / "files" / "emails.jsonl"
        self.save_emails_jsonl(submitted, emails_path)

        # 6. Save evaluation configuration
        print(f"\n🔍 Generating evaluation configuration...")
        check_students = self.save_evaluation_config(not_submitted, num_check_students, output_dir)

        # 7. Statistics
        print(f"\n📊 Task statistics:")
        print(f"   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        print(f"   Total students: {num_students}")
        print(f"   ├─ Enrolled students: {len(enrolled_students)}")
        print(f"   │  ├─ Submitted assignment: {len(submitted)} (no reminder needed)")
        print(f"   │  └─ Not submitted: {len(not_submitted)} (need reminder)")
        print(f"   └─ Dropped students: {len(dropped_students)} (no reminder needed)")
        print(f"   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        print(f"   \n   🎯 Evaluation will check all {len(check_students)} non-submitted students")

        print(f"\n✅ Configuration generation completed!")
        
        return {
            "total_students": num_students,
            "enrolled": len(enrolled_students),
            "dropped": len(dropped_students),
            "submitted": len(submitted),
            "not_submitted": len(not_submitted),
            "to_remind": len(check_students)
        }


def main():
    parser = argparse.ArgumentParser(description="Course Assistant Task Configuration Generator")

    # Basic parameters
    parser.add_argument("--num-students", type=int, default=15,
                       help="Total number of students (default: 15)")
    parser.add_argument("--dropout-rate", type=float, default=0.1,
                       help="Dropout rate (0-1, default: 0.1)")
    parser.add_argument("--submission-rate", type=float, default=0.7,
                       help="Assignment submission rate (0-1, default: 0.7)")
    parser.add_argument("--num-check", type=int, default=2,
                       help="Number of students to check (deprecated, now checks all non-submitted students, kept for backward compatibility)")

    # Other parameters
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")
    parser.add_argument("--output-dir", type=str, default=".",
                       help="Output directory (default: current directory)")
    
    args = parser.parse_args()

    # Generate configuration
    generator = CourseAssistantConfigGenerator(seed=args.seed)
    output_dir = Path(args.output_dir)

    stats = generator.generate_config(
        output_dir=output_dir,
        num_students=args.num_students,
        dropout_rate=args.dropout_rate,
        submission_rate=args.submission_rate,
        num_check_students=args.num_check,
        seed=args.seed
    )

    print(f"\n💡 Usage example:")
    print(f"   python preprocess/main.py --agent_workspace /path/to/workspace")
    print(f"\n🎉 Task configuration generated!")


if __name__ == "__main__":
    main()

