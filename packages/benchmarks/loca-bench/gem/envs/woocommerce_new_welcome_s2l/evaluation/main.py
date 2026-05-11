from argparse import ArgumentParser
import sys
import os
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Tuple, Any, Optional



from mcp_convert.mcps.google_cloud.database_utils import GoogleCloudDatabase
from mcp_convert.mcps.email.database_utils import EmailDatabase


def get_database_directories(agent_workspace: str) -> Tuple[str, str, str]:
    """Determine database directories based on agent workspace"""
    workspace_parent = Path(agent_workspace).parent
    woocommerce_db_dir = str(workspace_parent / "local_db" / "woocommerce")
    email_db_dir = str(workspace_parent / "local_db" / "emails")
    gcloud_db_dir = str(workspace_parent / "local_db" / "google_cloud")
    return woocommerce_db_dir, email_db_dir, gcloud_db_dir


def read_json(file_path: str) -> dict:
    """Read JSON file helper"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"⚠️  Warning: Could not read {file_path}: {e}")
        return {}

class BigQueryDataValidator:
    """Validate BigQuery data integrity and customer updates (using local database)"""

    def __init__(self, gcloud_db: GoogleCloudDatabase, project_id: str = "local-project", 
                 dataset_id: str = "woocommerce_crm"):
        self.gcloud_db = gcloud_db
        self.project_id = project_id
        self.dataset_id = dataset_id
        self.table_name = "customers"

    def get_all_customers(self) -> List[Dict]:
        """Get all customers from BigQuery local database"""
        try:
            # Query the table using GoogleCloudDatabase
            query = f"SELECT * FROM `{self.project_id}.{self.dataset_id}.{self.table_name}`"
            result = self.gcloud_db.run_bigquery_query(query)
            
            if result.get('status') == 'DONE':
                return result.get('results', [])
            else:
                error_msg = result.get('error', 'Unknown error')
                print(f"❌ Query failed: {error_msg}")
                return []
        except Exception as e:
            print(f"❌ Error getting all customers: {e}")
            import traceback
            traceback.print_exc()
            return []

    def get_customer_by_email(self, email: str) -> Optional[Dict]:
        """Get customer by email from BigQuery local database"""
        try:
            # Query with WHERE clause - escape single quotes in email
            safe_email = email.replace("'", "''")
            query = f"SELECT * FROM `{self.project_id}.{self.dataset_id}.{self.table_name}` WHERE email = '{safe_email}'"
            result = self.gcloud_db.run_bigquery_query(query)
            
            if result.get('status') == 'DONE':
                results = result.get('results', [])
                return results[0] if results else None
            else:
                error_msg = result.get('error', 'Unknown error')
                print(f"❌ Query failed: {error_msg}")
                return None
        except Exception as e:
            print(f"❌ Error getting customer by email: {e}")
            import traceback
            traceback.print_exc()
            return None

    def load_initial_customer_data(self, task_root: Path = None) -> List[Dict]:
        """Load initial customer data from JSON file"""
        try:
            # Use task_root if provided, otherwise fall back to code directory
            if task_root is None:
                task_root = Path(__file__).parent.parent

            customers_data_file = task_root / "preprocess" / "customers_data.json"

            with open(customers_data_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"❌ Error loading initial customer data: {e}")
            return []

    def load_woocommerce_first_time_customers(self, task_root: Path = None) -> List[Dict]:
        """Load WooCommerce first-time customers from generated orders"""
        try:
            # Use task_root if provided, otherwise fall back to code directory
            if task_root is None:
                task_root = Path(__file__).parent.parent

            orders_file = task_root / "preprocess" / "generated_orders.json"

            print(f"📁 Looking for orders file: {orders_file}")

            if not orders_file.exists():
                print(f"❌ Orders file not found: {orders_file}")
                print(f"   Please ensure preprocessing completed successfully")
                return []

            with open(orders_file, 'r', encoding='utf-8') as f:
                orders_data = json.load(f)

            # Get first-time orders
            first_time_orders = orders_data.get("first_time_orders", [])
            
            if not first_time_orders:
                print(f"⚠️  No first-time orders found in {orders_file}")
                return []
            
            # Extract unique customer emails
            first_time_customers = []
            seen_emails = set()
            
            for order in first_time_orders:
                # Try both formats: customer_email (simple) and billing.email (WooCommerce)
                email = order.get('customer_email') or order.get('billing', {}).get('email')
                if email and email not in seen_emails:
                    seen_emails.add(email)
                    
                    # Extract name - try both formats
                    if 'customer_name' in order:
                        # Simple format: split customer_name
                        name_parts = order.get('customer_name', '').split(' ', 1)
                        first_name = name_parts[0] if name_parts else ''
                        last_name = name_parts[1] if len(name_parts) > 1 else ''
                    else:
                        # WooCommerce format: use billing fields
                        first_name = order.get('billing', {}).get('first_name', '')
                        last_name = order.get('billing', {}).get('last_name', '')
                    
                    first_time_customers.append({
                        'email': email,
                        'first_name': first_name,
                        'last_name': last_name
                    })

            print(f"📊 Found {len(first_time_customers)} first-time customers from generated orders")
            return first_time_customers

        except Exception as e:
            print(f"❌ Error loading WooCommerce data: {e}")
            import traceback
            traceback.print_exc()
            return []

    def verify_initial_data_integrity(self, initial_customers: List[Dict]) -> Tuple[bool, str]:
        """Verify that initial customer data is preserved in BigQuery"""
        print("🔍 Verifying initial data integrity...")

        try:
            # Get all customers from local BigQuery database
            db_customers = self.get_all_customers()
            db_emails = {c.get('email'): c for c in db_customers}

            missing_customers = []
            modified_customers = []

            for initial_customer in initial_customers:
                email = initial_customer.get('email')
                if not email:
                    continue

                # Check if customer exists in database
                if email not in db_emails:
                    missing_customers.append(email)
                    continue

                db_customer = db_emails[email]

                # Verify key fields haven't been modified (except welcome_email fields)
                fields_to_check = ['woocommerce_id', 'first_name', 'last_name', 'phone']
                for field in fields_to_check:
                    initial_value = initial_customer.get(field)
                    db_value = db_customer.get(field)

                    if str(initial_value) != str(db_value):
                        modified_customers.append({
                            'email': email,
                            'field': field,
                            'initial': initial_value,
                            'current': db_value
                        })

            # Report results
            if missing_customers:
                print(f"❌ Missing customers: {missing_customers}")

            if modified_customers:
                print(f"❌ Modified customers: {modified_customers}")

            integrity_ok = len(missing_customers) == 0 and len(modified_customers) == 0

            if integrity_ok:
                print(f"✅ Initial data integrity verified: {len(initial_customers)} customers preserved")
                return True, f"All {len(initial_customers)} initial customers preserved correctly"
            else:
                return False, f"Data integrity issues: {len(missing_customers)} missing, {len(modified_customers)} modified"

        except Exception as e:
            print(f"❌ Error verifying data integrity: {e}")
            return False, f"Data integrity check failed: {e}"

    def verify_new_customer_insertions(self, first_time_customers: List[Dict], initial_customers: List[Dict]) -> Tuple[bool, str]:
        """Verify that new first-time customers were properly inserted/updated in BigQuery
        
        Also verifies that ONLY first-time customers were updated (no historical customers)
        """
        print("🔍 Verifying new customer insertions in BigQuery...")

        try:
            # Build set of first-time customer emails for quick lookup
            first_time_emails = {c.get('email') for c in first_time_customers if c.get('email')}
            
            # Build set of initial customer emails
            initial_emails = {c.get('email') for c in initial_customers if c.get('email')}
            
            print(f"   📋 First-time customers: {len(first_time_emails)}")
            print(f"   📋 Historical customers: {len(initial_emails)}")
            
            correctly_updated = 0
            not_synced = []
            not_marked = []

            # Check first-time customers
            for customer in first_time_customers:
                email = customer.get('email')
                if not email:
                    continue

                # Get customer from BigQuery local database
                db_customer = self.get_customer_by_email(email)

                if not db_customer:
                    not_synced.append(email)
                    print(f"   ❌ {email}: NOT SYNCED to BigQuery")
                    continue

                # Check if welcome_email_sent is properly updated
                welcome_sent = db_customer.get('welcome_email_sent', False)
                welcome_date = db_customer.get('welcome_email_date')

                if welcome_sent and welcome_date:
                    correctly_updated += 1
                    print(f"   ✅ {email}: synced to BigQuery and marked as sent on {welcome_date}")
                else:
                    not_marked.append(email)
                    print(f"   ⚠️  {email}: synced to BigQuery but welcome_email_sent={welcome_sent}, welcome_email_date={welcome_date}")

            # NEW CHECK: Verify no historical customers were incorrectly marked as sent
            print(f"\n🔍 Verifying historical customers were NOT modified...")
            incorrectly_marked = []
            
            for customer in initial_customers:
                email = customer.get('email')
                if not email or email in first_time_emails:
                    continue  # Skip first-time customers
                
                db_customer = self.get_customer_by_email(email)
                if not db_customer:
                    continue  # Customer not in DB (expected for some scenarios)
                
                # Check if this historical customer was incorrectly marked as sent
                welcome_sent = db_customer.get('welcome_email_sent', False)
                welcome_date = db_customer.get('welcome_email_date')
                
                # Historical customers should NOT have welcome_email_sent updated recently
                if welcome_sent and welcome_date:
                    # Check if this was in the initial data
                    initial_customer = next((c for c in initial_customers if c.get('email') == email), None)
                    initial_sent = initial_customer.get('welcome_email_sent', False) if initial_customer else False
                    
                    # If it wasn't marked before but is now, it's an error
                    if not initial_sent:
                        incorrectly_marked.append(email)
                        print(f"   ❌ {email}: HISTORICAL customer incorrectly marked as welcome_email_sent")
            
            # NEW CHECK: Verify no unknown customers were incorrectly inserted and marked
            print(f"\n🔍 Verifying no unknown customers were incorrectly inserted...")
            unknown_inserted = []
            
            # Get all customers currently in BigQuery
            all_db_customers = self.get_all_customers()
            
            for db_customer in all_db_customers:
                email = db_customer.get('email')
                if not email:
                    continue
                
                # Check if marked as welcome email sent
                welcome_sent = db_customer.get('welcome_email_sent', False)
                welcome_date = db_customer.get('welcome_email_date')
                
                if welcome_sent and welcome_date:
                    # This customer is marked as sent, verify they are in first-time list
                    if email not in first_time_emails and email not in initial_emails:
                        # This is an unknown customer that shouldn't be here
                        unknown_inserted.append(email)
                        print(f"   ❌ {email}: UNKNOWN customer incorrectly inserted and marked")
                    elif email in initial_emails:
                        # Already checked above in historical customers check
                        pass

            # Print summary
            print(f"\n   📊 BigQuery Sync Summary:")
            print(f"      - Total first-time customers: {len(first_time_customers)}")
            print(f"      - Correctly synced and marked: {correctly_updated}")
            print(f"      - Not synced to BigQuery: {len(not_synced)}")
            print(f"      - Synced but not marked: {len(not_marked)}")
            print(f"      - Historical customers incorrectly marked: {len(incorrectly_marked)}")
            print(f"      - Unknown customers incorrectly inserted: {len(unknown_inserted)}")

            if not_synced:
                print(f"\n   ⚠️  Customers NOT synced to BigQuery (Agent needs to sync them):")
                for email in not_synced[:5]:  # Show first 5
                    print(f"      - {email}")
                if len(not_synced) > 5:
                    print(f"      ... and {len(not_synced) - 5} more")
            
            if incorrectly_marked:
                print(f"\n   ❌ Historical customers that should NOT be marked:")
                for email in incorrectly_marked[:5]:
                    print(f"      - {email}")
                if len(incorrectly_marked) > 5:
                    print(f"      ... and {len(incorrectly_marked) - 5} more")
            
            if unknown_inserted:
                print(f"\n   ❌ Unknown customers that should NOT be inserted:")
                for email in unknown_inserted[:5]:
                    print(f"      - {email}")
                if len(unknown_inserted) > 5:
                    print(f"      ... and {len(unknown_inserted) - 5} more")

            success = (len(not_synced) == 0 and 
                      len(not_marked) == 0 and 
                      len(incorrectly_marked) == 0 and
                      len(unknown_inserted) == 0)

            if success:
                print(f"\n✅ All {correctly_updated} first-time customers properly synced to BigQuery")
                return True, f"All {correctly_updated} first-time customers synced correctly, no incorrect insertions"
            else:
                issues = []
                if not_synced:
                    issues.append(f"{len(not_synced)} not synced to BigQuery")
                if not_marked:
                    issues.append(f"{len(not_marked)} not marked")
                if incorrectly_marked:
                    issues.append(f"{len(incorrectly_marked)} historical customers incorrectly marked")
                if unknown_inserted:
                    issues.append(f"{len(unknown_inserted)} unknown customers incorrectly inserted")
                return False, f"BigQuery sync issues: {'; '.join(issues)}"

        except Exception as e:
            print(f"❌ Error verifying customer insertions: {e}")
            import traceback
            traceback.print_exc()
            return False, f"Customer insertion verification failed: {e}"

class WelcomeEmailValidator:
    """Validate welcome email format and content (using local database)"""

    def __init__(self, email_db: EmailDatabase, admin_email: str, task_root: Path = None):
        self.email_db = email_db
        self.admin_email = admin_email
        self.task_root = task_root or Path(__file__).parent.parent

        # Load expected email template
        self.load_email_template()

    def load_email_template(self):
        """Load the welcome email template"""
        try:
            template_file = self.task_root / "initial_workspace" / "welcome_email_template.md"

            with open(template_file, 'r', encoding='utf-8') as f:
                template_content = f.read()

            # Extract expected elements from template
            self.expected_subject_pattern = r"Welcome to.*Exclusive offers await you"
            self.expected_content_elements = [
                "Thank you for placing your first order",
                "new customer",
                "exclusive offers",
                "WELCOME10",
                "Free Shipping",
                "Double Points",
                "Order ID:",
                "Order Amount:",
                "Order Date:",
                "Recommended for You",
                "Customer Service"
            ]

            print(f"✅ Loaded email template with {len(self.expected_content_elements)} expected elements")

        except Exception as e:
            print(f"❌ Error loading email template: {e}")
            self.expected_subject_pattern = r"Welcome"
            self.expected_content_elements = []

    def verify_welcome_emails_sent(self, first_time_customers: List[Dict], all_customer_emails: List[str]) -> Tuple[bool, str]:
        """Verify that welcome emails were sent to first-time customers with correct format
        
        Also verifies that ONLY first-time customers received welcome emails (no historical customers)
        
        Args:
            first_time_customers: List of first-time customers who should receive emails
            all_customer_emails: List of ALL customer emails (to check for incorrect sends)
        """
        print("📧 Verifying welcome emails...")

        try:
            # Extract first-time customer emails
            first_time_emails = [c.get('email') for c in first_time_customers if c.get('email')]

            if not first_time_emails:
                return False, "No first-time customer emails to verify"

            print(f"   Checking emails for {len(first_time_emails)} first-time customers")

            # Get sent emails from local database
            user_dir = self.email_db._get_user_data_dir(self.admin_email)
            emails_file = os.path.join(user_dir, "emails.json")
            
            try:
                with open(emails_file, 'r', encoding='utf-8') as f:
                    emails_data = json.load(f)
            except Exception as e:
                print(f"❌ Error reading emails from database: {e}")
                return False, f"Failed to read emails: {e}"

            # Build sets for quick lookup
            first_time_emails_set = set(email.lower() for email in first_time_emails)
            all_known_emails_set = set(email.lower() for email in all_customer_emails)
            
            # Find sent emails to customers
            verified_first_time = set()
            incorrectly_sent_historical = set()  # Historical customers who received emails
            incorrectly_sent_unknown = set()  # Unknown customers who received emails
            content_verification_results = []
            
            for email_id, email_data in emails_data.items():
                # Check if email is in Sent folder
                if email_data.get('folder') != 'Sent':
                    continue
                
                # Get recipients
                to_addr = email_data.get('to', '').lower()
                subject = email_data.get('subject', '')
                
                # Skip if not a welcome email (based on subject pattern)
                if not re.search(self.expected_subject_pattern, subject, re.IGNORECASE):
                    continue
                
                # Extract all email addresses from 'to' field
                # Simple extraction - look for patterns like email@domain.com
                recipient_emails = re.findall(r'[\w\.-]+@[\w\.-]+\.\w+', to_addr)
                
                # Check recipients against known customers
                matching_first_time = []
                matching_historical = []
                matching_unknown = []
                
                for recipient_email in recipient_emails:
                    recipient_lower = recipient_email.lower()
                    
                    if recipient_lower in first_time_emails_set:
                        # Correct: first-time customer
                        matching_first_time.append(recipient_email)
                        verified_first_time.add(recipient_email)
                    elif recipient_lower in all_known_emails_set:
                        # Error: historical customer
                        matching_historical.append(recipient_email)
                        incorrectly_sent_historical.add(recipient_email)
                    else:
                        # Error: unknown customer
                        matching_unknown.append(recipient_email)
                        incorrectly_sent_unknown.add(recipient_email)
                
                if matching_first_time:
                    # Verify subject and content for first-time customers
                    body = email_data.get('body', '') + email_data.get('html_body', '')
                    
                    # Verify subject format
                    subject_ok = bool(re.search(self.expected_subject_pattern, subject, re.IGNORECASE))
                    
                    # Verify content elements
                    content_elements_found = []
                    body_lower = body.lower()
                    for element in self.expected_content_elements:
                        if element.lower() in body_lower:
                            content_elements_found.append(element)
                    
                    content_ok = len(content_elements_found) >= len(self.expected_content_elements) * 0.7  # 70% of elements
                    
                    content_verification_results.append({
                        "recipients": matching_first_time,
                        "subject_ok": subject_ok,
                        "content_ok": content_ok,
                        "elements_found": len(content_elements_found),
                        "total_elements": len(self.expected_content_elements),
                        "subject": subject[:100]
                    })
                
                if matching_historical:
                    print(f"   ❌ Welcome email incorrectly sent to historical customer(s): {matching_historical}")
                
                if matching_unknown:
                    print(f"   ❌ Welcome email incorrectly sent to unknown customer(s): {matching_unknown}")

            # Calculate results
            missing_emails = [email for email in first_time_emails if email not in verified_first_time]
            total_first_time = len(first_time_emails)
            emails_sent = len(verified_first_time)
            content_passed = sum(1 for r in content_verification_results if r["subject_ok"] and r["content_ok"])

            print(f"\n   📊 Email Verification Results:")
            print(f"      - Total first-time customers: {total_first_time}")
            print(f"      - Welcome emails sent to first-time: {emails_sent}")
            print(f"      - Content format passed: {content_passed}")
            print(f"      - Missing emails: {len(missing_emails)}")
            print(f"      - Incorrectly sent to historical: {len(incorrectly_sent_historical)}")
            print(f"      - Incorrectly sent to unknown: {len(incorrectly_sent_unknown)}")

            if missing_emails:
                print(f"\n      ⚠️  Missing welcome emails for:")
                for email in missing_emails[:5]:
                    print(f"         - {email}")
                if len(missing_emails) > 5:
                    print(f"         ... and {len(missing_emails) - 5} more")
            
            if incorrectly_sent_historical:
                print(f"\n      ❌ Welcome emails incorrectly sent to historical customers:")
                for email in list(incorrectly_sent_historical)[:5]:
                    print(f"         - {email}")
                if len(incorrectly_sent_historical) > 5:
                    print(f"         ... and {len(incorrectly_sent_historical) - 5} more")
            
            if incorrectly_sent_unknown:
                print(f"\n      ❌ Welcome emails incorrectly sent to unknown customers:")
                for email in list(incorrectly_sent_unknown)[:5]:
                    print(f"         - {email}")
                if len(incorrectly_sent_unknown) > 5:
                    print(f"         ... and {len(incorrectly_sent_unknown) - 5} more")

            # Success criteria: all first-time customers received properly formatted emails
            # AND no historical or unknown customers received welcome emails
            success = (emails_sent == total_first_time and
                      len(missing_emails) == 0 and
                      content_passed == len(content_verification_results) and
                      len(incorrectly_sent_historical) == 0 and
                      len(incorrectly_sent_unknown) == 0)

            if success:
                return True, f"All {total_first_time} welcome emails sent correctly (no incorrect recipients)"
            else:
                issues = []
                if emails_sent < total_first_time:
                    issues.append(f"{total_first_time - emails_sent} emails not sent")
                if content_passed < len(content_verification_results):
                    issues.append(f"{len(content_verification_results) - content_passed} emails with format issues")
                if incorrectly_sent_historical:
                    issues.append(f"{len(incorrectly_sent_historical)} historical customers incorrectly received emails")
                if incorrectly_sent_unknown:
                    issues.append(f"{len(incorrectly_sent_unknown)} unknown customers incorrectly received emails")

                return False, f"Email verification issues: {'; '.join(issues)}"

        except Exception as e:
            print(f"❌ Error verifying welcome emails: {e}")
            import traceback
            traceback.print_exc()
            return False, f"Welcome email verification failed: {e}"

def run_local_evaluation(agent_workspace: str, groundtruth_workspace: str = None) -> Tuple[bool, str]:
    """Run evaluation with focus on BigQuery data integrity and welcome email verification (local database)"""

    print("=" * 80)
    print("🚀 WooCommerce New Welcome Task Evaluation (Local Database)")
    print("=" * 80)
    print("\n📋 Evaluation Requirements:")
    print("   • Identify first-time customers (within 7 days, completed orders only)")
    print("   • Sync first-time customers to BigQuery with welcome_email_sent=true")
    print("   • Send welcome emails ONLY to first-time customers")
    print("   • Do NOT process historical customers or noise data")
    print("=" * 80)

    # Determine task_root and database directories
    # When agent_workspace is provided, task_root is its parent directory
    task_root = Path(agent_workspace).parent

    woocommerce_db_dir, email_db_dir, gcloud_db_dir = get_database_directories(agent_workspace)

    print(f"\n📂 Task Root: {task_root}")
    print(f"📂 Database Directories:")
    print(f"   WooCommerce: {woocommerce_db_dir}")
    print(f"   Google Cloud: {gcloud_db_dir}")
    print(f"   Email: {email_db_dir}")
    
    # Read groundtruth metadata (if exists)
    groundtruth_metadata = None
    if groundtruth_workspace:
        metadata_file = Path(groundtruth_workspace) / "generation_metadata.json"
        if metadata_file.exists():
            try:
                groundtruth_metadata = read_json(str(metadata_file))
                print(f"\n📋 Loaded groundtruth metadata:")
                gen_params = groundtruth_metadata.get('generation_params', {})
                print(f"   • Total orders: {gen_params.get('total_orders', 'N/A')}")
                print(f"   • First-time customers: {gen_params.get('first_time_customers', 'N/A')}")
                print(f"   • Noise (outside 7-day window): {gen_params.get('noise_outside_window', 'N/A')}")
                print(f"   • Noise (incomplete orders): {gen_params.get('noise_incomplete', 'N/A')}")
                print(f"   • Random seed: {gen_params.get('seed', 'N/A')}")
            except Exception as e:
                print(f"   ⚠️  Could not load groundtruth metadata: {e}")
    
    # Check if databases exist
    if not Path(gcloud_db_dir).exists():
        error_msg = f"❌ Google Cloud database directory not found: {gcloud_db_dir}"
        print(f"\n{error_msg}")
        print("   Please run preprocessing first to initialize the database.")
        return False, error_msg
    
    if not Path(email_db_dir).exists():
        error_msg = f"❌ Email database directory not found: {email_db_dir}"
        print(f"\n{error_msg}")
        print("   Please run preprocessing first to initialize the database.")
        return False, error_msg
    
    if not Path(woocommerce_db_dir).exists():
        error_msg = f"❌ WooCommerce database directory not found: {woocommerce_db_dir}"
        print(f"\n{error_msg}")
        print("   Please run preprocessing first to initialize the database.")
        return False, error_msg
    
    # Initialize databases
    print("\n📊 Initializing Local Databases...")
    try:
        gcloud_db = GoogleCloudDatabase(data_dir=gcloud_db_dir)
        email_db = EmailDatabase(data_dir=email_db_dir)
        print("✅ Databases initialized successfully")
    except Exception as e:
        error_msg = f"❌ Failed to initialize databases: {e}"
        print(error_msg)
        import traceback
        traceback.print_exc()
        return False, error_msg
    
    # Set environment variables
    os.environ['GOOGLE_CLOUD_DATA_DIR'] = gcloud_db_dir
    os.environ['EMAIL_DATA_DIR'] = email_db_dir
    os.environ['WOOCOMMERCE_DATA_DIR'] = woocommerce_db_dir
    
    # Admin email configuration
    admin_email = "admin@woocommerce.local"
    
    results = []

    # 1. BigQuery Data Validation
    print("\n" + "=" * 80)
    print("STEP 1: BigQuery Data Integrity Validation (Local DB)")
    print("=" * 80)

    try:
        db_validator = BigQueryDataValidator(gcloud_db=gcloud_db, project_id="local-project")

        # Load initial data (pass task_root)
        initial_customers = db_validator.load_initial_customer_data(task_root=task_root)
        first_time_customers = db_validator.load_woocommerce_first_time_customers(task_root=task_root)

        if not initial_customers:
            results.append(("BigQuery Data Load", False, "Failed to load initial customer data"))
        elif not first_time_customers:
            results.append(("BigQuery Data Load", False, "Failed to load first-time customer data"))
        else:
            results.append(("BigQuery Data Load", True, f"Loaded {len(initial_customers)} initial + {len(first_time_customers)} first-time customers"))

            # Check initial data integrity
            integrity_ok, integrity_msg = db_validator.verify_initial_data_integrity(initial_customers)
            results.append(("BigQuery Data Integrity", integrity_ok, integrity_msg))

            # Check new customer insertions (pass both first-time and initial customers)
            insertion_ok, insertion_msg = db_validator.verify_new_customer_insertions(
                first_time_customers, 
                initial_customers
            )
            results.append(("BigQuery Customer Updates", insertion_ok, insertion_msg))

    except Exception as e:
        print(f"❌ BigQuery validation failed: {e}")
        import traceback
        traceback.print_exc()
        results.append(("BigQuery Validation", False, f"BigQuery validation error: {e}"))

    # 2. Welcome Email Validation
    print("\n" + "=" * 80)
    print("STEP 2: Welcome Email Format Validation (Local DB)")
    print("=" * 80)

    try:
        email_validator = WelcomeEmailValidator(email_db=email_db, admin_email=admin_email, task_root=task_root)

        # Load first-time customers for email verification
        if 'first_time_customers' in locals() and 'initial_customers' in locals():
            # Build list of all customer emails (first-time + historical)
            all_customer_emails = []
            all_customer_emails.extend([c.get('email') for c in first_time_customers if c.get('email')])
            all_customer_emails.extend([c.get('email') for c in initial_customers if c.get('email')])
            
            email_ok, email_msg = email_validator.verify_welcome_emails_sent(
                first_time_customers,
                all_customer_emails
            )
            results.append(("Welcome Email Format", email_ok, email_msg))
        else:
            results.append(("Welcome Email Format", False, "No customer data available"))

    except Exception as e:
        print(f"❌ Email validation failed: {e}")
        import traceback
        traceback.print_exc()
        results.append(("Welcome Email Validation", False, f"Email validation error: {e}"))

    # Summary
    print("\n" + "=" * 80)
    print("📊 EVALUATION SUMMARY")
    print("=" * 80)

    passed = sum(1 for _, success, _ in results if success)
    total = len(results)

    for service, success, message in results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} | {service}: {message}")

    print("=" * 80)
    overall_pass = passed == total
    print(f"\nOverall: {passed}/{total} checks passed")
    
    if overall_pass:
        print("\n🎉 ALL TESTS PASSED!")
        print("=" * 80)
        print("✅ Successfully identified first-time customers from WooCommerce")
        print("✅ Successfully synced first-time customers to BigQuery")
        print("✅ Successfully sent welcome emails with correct format")
        print("✅ No historical customers or noise data was incorrectly processed")
        print("=" * 80)
    else:
        print("\n❌ SOME TESTS FAILED")
        print("=" * 80)
        print("Please review the failed tests above")
        print("\n📝 Common Issues:")
        print("   • Did the agent correctly identify first-time customers (only 1 completed order within 7 days)?")
        print("   • Did the agent filter out orders outside the 7-day window?")
        print("   • Did the agent filter out incomplete orders (processing/on-hold)?")
        print("   • Did the agent sync ONLY first-time customers to BigQuery?")
        print("   • Did the agent send welcome emails ONLY to first-time customers?")
        print("   • Did the agent avoid processing historical customers?")
        print("\n💡 Tips:")
        print("   • Check WooCommerce order status: should be 'completed'")
        print("   • Check WooCommerce order dates: should be within last 7 days")
        print("   • Check BigQuery: first-time customers should have welcome_email_sent=true")
        print("   • Check Email: only first-time customers should receive emails")
        print("=" * 80)

    # Save results
    results_data = {
        "timestamp": datetime.now().isoformat(),
        "overall_pass": overall_pass,
        "passed_checks": passed,
        "total_checks": total,
        "results": [{"service": s, "passed": p, "message": m} for s, p, m in results]
    }

    summary_msg = "Evaluation PASSED - All checks successful!" if overall_pass else f"Evaluation FAILED - {total - passed}/{total} checks failed"
    return overall_pass, summary_msg

def main():
    parser = ArgumentParser(description="Evaluate WooCommerce new welcome task with BigQuery and email validation (local database)")
    parser.add_argument("--agent_workspace", type=str, required=True, help="Path to agent's workspace directory")
    parser.add_argument("--groundtruth_workspace", type=str, required=False, help="Path to groundtruth workspace directory")
    parser.add_argument("--res_log_file", type=str, required=False, help="Path to result log file")
    parser.add_argument("--launch_time", required=False, help="Launch time")

    args = parser.parse_args()
    
    if not args.agent_workspace:
        print("❌ Error: --agent_workspace is required")
        sys.exit(1)
    
    try:
        success, message = run_local_evaluation(
            args.agent_workspace,
            args.groundtruth_workspace
        )

        print("\n" + "=" * 80)
        print("📋 FINAL EVALUATION RESULT")
        print("=" * 80)
        print(f"{message}")
        
        if success:
            print("\n✅ EVALUATION PASSED")
            sys.exit(0)
        else:
            print("\n❌ EVALUATION FAILED")
            sys.exit(1)
            
    except Exception as e:
        print(f"❌ Critical evaluation error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()