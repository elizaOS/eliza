#!/usr/bin/env python3
"""
Updated evaluation script for woocommerce-stock-alert task (Local Database Version).
This script validates:
1. Google Sheets updates (new low-stock products added)
2. Email notifications sent to purchasing manager
"""

import json
import os
import sys
from typing import Dict, List, Tuple, Any
from pathlib import Path

# Add task directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = Path(current_dir).parent
sys.path.insert(0, str(task_dir))

class StockAlertEvaluator:
    """Evaluator for stock alert system validation using local databases"""

    def __init__(self, agent_workspace: str, email_db=None, google_sheet_db=None, woocommerce_db=None):
        self.agent_workspace = agent_workspace
        self.task_dir = Path(agent_workspace).parent
        self.initial_workspace = self.task_dir / "initial_workspace"
        self.preprocess_dir = self.task_dir / "preprocess"
        self.purchasing_manager_email = "laura_thompson@mcp.com"
        self.admin_email = "admin@woocommerce.local"
        
        # Store database instances
        self.email_db = email_db
        self.google_sheet_db = google_sheet_db
        self.woocommerce_db = woocommerce_db
        
        # Load expected products dynamically from generated data
        self.expected_low_stock_products = self._load_expected_low_stock_products()
        
    def _load_expected_low_stock_products(self) -> List[Dict]:
        """
        Load expected low-stock products from the generated woocommerce_products.json
        Returns products where stock_quantity < stock_threshold
        """
        try:
            products_file = self.preprocess_dir / "woocommerce_products.json"
            
            if not products_file.exists():
                print(f"⚠️  Warning: Generated products file not found: {products_file}")
                print("   Falling back to reading from initial_workspace")
                products_file = self.initial_workspace / "woocommerce_products.json"
            
            if not products_file.exists():
                raise FileNotFoundError(f"Products file not found: {products_file}")
            
            with open(products_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                products = data.get("products", [])
            
            # Filter for low-stock products (stock_quantity < stock_threshold)
            low_stock_products = [
                {
                    "id": p.get("id"),
                    "name": p.get("name"),
                    "sku": p.get("sku"),
                    "stock_quantity": p.get("stock_quantity"),
                    "stock_threshold": p.get("stock_threshold")
                }
                for p in products
                if p.get("stock_quantity", 0) < p.get("stock_threshold", 0)
            ]
            
            print(f"📊 Loaded {len(low_stock_products)} expected low-stock products from generated data")
            
            return low_stock_products
            
        except Exception as e:
            print(f"⚠️  Warning: Could not load expected products dynamically: {e}")
            print("   Evaluation will proceed with empty expected list")
            return []

    def load_woocommerce_products(self) -> List[Dict]:
        """Load WooCommerce products configuration"""
        # Try preprocess directory first (generated data)
        products_file = self.preprocess_dir / "woocommerce_products.json"
        
        if not products_file.exists():
            # Fallback to initial_workspace
            products_file = self.initial_workspace / "woocommerce_products.json"

        if not products_file.exists():
            raise FileNotFoundError(f"Products file not found: {products_file}")

        with open(products_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get("products", [])

    def get_spreadsheet_id(self) -> str:
        """Get the spreadsheet ID from files/sheet_id.txt"""
        try:
            sheet_id_file = self.task_dir / "files" / "sheet_id.txt"
            if sheet_id_file.exists():
                with open(sheet_id_file, 'r') as f:
                    return f.read().strip()
        except Exception:
            pass
        return None

    def read_sheet_data(self, spreadsheet_id: str, range_name: str = "Stock Alert!A:H") -> List[List[str]]:
        """Read data from Google Sheets using local database"""
        try:
            if not self.google_sheet_db:
                raise ValueError("Google Sheets database not initialized")
            
            # Parse range notation (e.g., "Stock Alert!A:H")
            if "!" in range_name:
                sheet_name, cell_range = range_name.split("!", 1)
            else:
                sheet_name = "Stock Alert"
                cell_range = range_name
            
            # Get values from local database using correct method name
            # get_values returns List[List[Any]], not a dict with 'values' key
            result = self.google_sheet_db.get_values(spreadsheet_id, sheet_name, cell_range)
            
            if result:
                return result
            
            return []
            
        except Exception as e:
            print(f"Error reading sheet data: {e}")
            import traceback
            traceback.print_exc()
            return []

    def parse_sheet_records(self, raw_data: List[List[str]]) -> List[Dict]:
        """Parse raw sheet data into structured records"""
        if not raw_data or len(raw_data) < 2:
            return []
        
        headers = raw_data[0]
        records = []
        
        for row in raw_data[1:]:
            # Pad row to match headers length
            padded_row = row + [''] * (len(headers) - len(row))
            record = dict(zip(headers, padded_row))
            records.append(record)
        
        return records

    def validate_google_sheets_updates(self) -> Tuple[bool, str]:
        """
        Validate Google Sheets updates:
        1. Check all low-stock products are present
        2. Verify data inserted correctly
        3. Ensure required columns exist
        """
        try:
            # Check if we have expected products loaded
            if not self.expected_low_stock_products:
                return False, "No expected low-stock products loaded. Please check product generation."
            
            # Get spreadsheet ID
            spreadsheet_id = self.get_spreadsheet_id()
            if not spreadsheet_id:
                return False, "Spreadsheet ID not found in files/sheet_id.txt"

            print(f"Validating Google Sheets: {spreadsheet_id}")
            print(f"Expected {len(self.expected_low_stock_products)} low-stock products")

            # Read data from Google Sheets
            raw_data = self.read_sheet_data(spreadsheet_id)
            if not raw_data:
                return False, "Could not read data from Google Sheets or sheet is empty"

            # Parse records
            records = self.parse_sheet_records(raw_data)
            expected_count = len(self.expected_low_stock_products)
            
            # Sheet should contain all low-stock products
            # Initial sheet only has 1 example row, Agent should add all low-stock products
            if len(records) < expected_count:
                return False, f"Insufficient records. Expected at least {expected_count} low-stock products, got {len(records)} records. Agent should identify and add all low-stock products to the sheet."

            # Verify required columns exist
            if not raw_data[0]:
                return False, "No headers found in sheet"
            
            headers = raw_data[0]
            required_columns = [
                "Product ID", "Product Name", "SKU", "Current Stock",
                "Safety Threshold", "Supplier Name", "Supplier ID", "Supplier Contact"
            ]
            
            missing_columns = [col for col in required_columns if col not in headers]
            if missing_columns:
                return False, f"Missing required columns: {missing_columns}"

            # Check all expected low-stock products are present
            # Convert all values to strings before stripping
            record_skus = {str(record.get("SKU", "")).strip() for record in records}
            expected_skus = {p["sku"] for p in self.expected_low_stock_products}

            missing_skus = expected_skus - record_skus
            if missing_skus:
                return False, f"Missing {len(missing_skus)} low-stock products in sheet. Missing SKUs: {sorted(list(missing_skus)[:5])}"

            # Check for unexpected products (normal-stock products that should NOT be in the sheet)
            # Load all products and identify normal-stock ones
            all_products = self.load_woocommerce_products()
            normal_stock_skus = {
                p.get("sku") for p in all_products 
                if p.get("stock_quantity", 0) >= p.get("stock_threshold", 0)
            }
            
            # Find any normal-stock products incorrectly added to sheet
            unexpected_skus = record_skus & normal_stock_skus  # Intersection
            if unexpected_skus:
                unexpected_sample = sorted(list(unexpected_skus)[:5])
                return False, f"Found {len(unexpected_skus)} normal-stock products in sheet that should NOT be there. These products have sufficient stock and don't need alerts. Unexpected SKUs: {unexpected_sample}. Sheet should ONLY contain low-stock products (stock_quantity < stock_threshold)."

            # Validate low-stock products data
            validation_errors = []
            for expected_product in self.expected_low_stock_products:
                found_record = None
                for record in records:
                    if str(record.get("SKU", "")).strip() == expected_product["sku"]:
                        found_record = record
                        break

                if not found_record:
                    validation_errors.append(f"Product {expected_product['name']} (SKU: {expected_product['sku']}) not found")
                    continue

                # Validate data accuracy - convert all values to strings first
                if str(found_record.get("Product Name", "")).strip() != expected_product["name"]:
                    validation_errors.append(f"Product name mismatch for {expected_product['sku']}: expected '{expected_product['name']}', got '{found_record.get('Product Name')}'")

                if str(found_record.get("Current Stock", "")).strip() != str(expected_product["stock_quantity"]):
                    validation_errors.append(f"Stock quantity mismatch for {expected_product['sku']}: expected {expected_product['stock_quantity']}, got {found_record.get('Current Stock')}")

                if str(found_record.get("Safety Threshold", "")).strip() != str(expected_product["stock_threshold"]):
                    validation_errors.append(f"Threshold mismatch for {expected_product['sku']}: expected {expected_product['stock_threshold']}, got {found_record.get('Safety Threshold')}")

            if validation_errors:
                # Only show first 5 errors to avoid overwhelming output
                error_summary = '; '.join(validation_errors[:5])
                if len(validation_errors) > 5:
                    error_summary += f" ... and {len(validation_errors) - 5} more errors"
                return False, f"Data validation errors: {error_summary}"

            # Check that records have non-empty required fields
            for i, record in enumerate(records):
                row_number = i + 2  # +2 because row 1 is headers and we're 0-indexed
                for col in ["Product ID", "Product Name", "SKU"]:
                    # Convert to string before stripping
                    if not str(record.get(col, "")).strip():
                        validation_errors.append(f"Empty {col} in row {row_number}")

            if validation_errors:
                error_summary = '; '.join(validation_errors[:5])
                if len(validation_errors) > 5:
                    error_summary += f" ... and {len(validation_errors) - 5} more errors"
                return False, f"Data completeness errors: {error_summary}"

            return True, f"Google Sheets correctly updated with {len(records)} records including all {len(self.expected_low_stock_products)} expected low-stock products"

        except Exception as e:
            return False, f"Google Sheets validation error: {str(e)}"

    def validate_email_notifications(self) -> Tuple[bool, str]:
        """
        Validate email notifications using local email database:
        1. Emails sent to purchasing manager (laura_thompson@mcp.com)
        2. For all low-stock products
        3. Emails follow the template format
        """
        try:
            # Check if we have expected products loaded
            if not self.expected_low_stock_products:
                return False, "No expected low-stock products loaded. Please check product generation."
            
            if not self.email_db:
                return False, "Email database not initialized"
            
            # Get sent emails from local database
            user_dir = self.email_db._get_user_data_dir(self.admin_email)
            emails_file = os.path.join(user_dir, "emails.json")
            
            if not os.path.exists(emails_file):
                return False, f"Email database file not found: {emails_file}"
            
            with open(emails_file, 'r', encoding='utf-8') as f:
                emails_data = json.load(f)
            
            # Find stock alert emails sent to purchasing manager
            stock_alert_emails = []
            manager_emails = []
            
            for _email_id, email_data in emails_data.items():
                # Check if email is in Sent folder
                if email_data.get('folder') != 'Sent':
                    continue
                
                # Get subject and recipients
                subject = email_data.get('subject', '')
                to_addr = email_data.get('to', '').lower()
                
                # Check if it's a stock alert email
                stock_alert_keywords = ['stock alert', '[stock alert]', 'low stock', 'safety threshold']
                is_stock_alert = any(keyword in subject.lower() for keyword in stock_alert_keywords)
                
                if is_stock_alert:
                    stock_alert_emails.append(email_data)
                    
                    # Check if sent to purchasing manager
                    if self.purchasing_manager_email.lower() in to_addr:
                        manager_emails.append(email_data)
            
            if not stock_alert_emails:
                return False, "No stock alert emails found in Sent folder"
            
            if not manager_emails:
                return False, f"No stock alert emails sent to purchasing manager ({self.purchasing_manager_email})"
            
            # Email count check: should match expected low-stock product count
            expected_count = len(self.expected_low_stock_products)
            print(f"Expected {expected_count} emails for {expected_count} low-stock products")
            print(f"Found {len(manager_emails)} emails to purchasing manager")
            
            # Allow some flexibility: at least the minimum expected count
            if len(manager_emails) < expected_count:
                return False, f"Expected at least {expected_count} emails to {self.purchasing_manager_email}, found only {len(manager_emails)}"
            
            # Validate email content and extract SKUs
            email_skus = set()
            validation_errors = []
            
            for email_data in manager_emails:
                subject = email_data.get('subject', '')
                body = email_data.get('body', '') + email_data.get('html_body', '')
                
                # Extract SKU from this email
                found_sku = None
                email_content = (subject + " " + body).upper()
                
                for product in self.expected_low_stock_products:
                    # Check for exact SKU match (case insensitive)
                    if product["sku"].upper() in email_content:
                        found_sku = product["sku"]
                        break
                
                if found_sku:
                    email_skus.add(found_sku)
                else:
                    # Don't fail immediately, collect the error
                    pass
                
                # Validate email format follows template (lenient checks)
                if "[Stock Alert]" not in subject and "stock alert" not in subject.lower():
                    validation_errors.append(f"Email subject doesn't follow template format: {subject}")
                
                if "Dear Purchasing Manager" not in body and "purchasing manager" not in body.lower():
                    validation_errors.append("Email body doesn't follow template format (missing greeting)")
                
                # Check for key alert content
                if "stock" not in body.lower() or "threshold" not in body.lower():
                    validation_errors.append("Email body doesn't contain stock alert information")
                
                # Check for template placeholders not replaced
                if "google_sheets_link" in body or "{google_sheets_link}" in body:
                    validation_errors.append("Email template placeholder not replaced")
            
            # Only show first 3 validation errors to avoid overwhelming output
            if validation_errors:
                error_summary = '; '.join(validation_errors[:3])
                if len(validation_errors) > 3:
                    error_summary += f" ... and {len(validation_errors) - 3} more errors"
                return False, f"Email validation errors: {error_summary}"
            
            # Check that all expected SKUs are present in emails
            expected_skus = {p["sku"] for p in self.expected_low_stock_products}
            missing_skus = expected_skus - email_skus
            
            if missing_skus:
                # Show first 5 missing SKUs
                missing_sample = sorted(list(missing_skus)[:5])
                return False, f"Missing emails for {len(missing_skus)} products. Sample missing SKUs: {missing_sample}"
            
            return True, f"Successfully found {len(manager_emails)} stock alert emails to {self.purchasing_manager_email} covering all {len(email_skus)} expected low-stock products"
        
        except Exception as e:
            print(f"❌ Email validation error: {e}")
            import traceback
            traceback.print_exc()
            return False, f"Email validation error: {str(e)}"

    def run_evaluation(self) -> Dict[str, Any]:
        """Run complete evaluation"""
        print("🔍 Starting Stock Alert Task Evaluation...")
        print("=" * 60)

        results = {}

        # 1. Validate Google Sheets updates
        print("📊 Validating Google Sheets updates...")
        sheets_success, sheets_msg = self.validate_google_sheets_updates()
        results["google_sheets_update"] = {
            "passed": sheets_success,
            "message": sheets_msg
        }
        print(f"   {'✅' if sheets_success else '❌'} {sheets_msg}")

        # 2. Validate email notifications
        print("📧 Validating email notifications...")
        email_success, email_msg = self.validate_email_notifications()
        results["email_notifications"] = {
            "passed": email_success,
            "message": email_msg
        }
        print(f"   {'✅' if email_success else '❌'} {email_msg}")

        # Overall result
        all_passed = sheets_success and email_success
        results["overall"] = {
            "passed": all_passed,
            "tests_passed": sum([sheets_success, email_success]),
            "total_tests": 2
        }

        print("=" * 60)
        if all_passed:
            print("🎉 All evaluations PASSED!")
            print("✓ Google Sheets correctly updated with new low-stock products")
            print("✓ Email notifications sent to purchasing manager")
        else:
            print("❌ Some evaluations FAILED!")
            if not sheets_success:
                print("  ✗ Google Sheets update validation failed")
            if not email_success:
                print("  ✗ Email notification validation failed")

        return results


def main():
    """Main evaluation function"""
    from argparse import ArgumentParser

    parser = ArgumentParser(description="Evaluate Stock Alert System")
    parser.add_argument("--agent_workspace", required=True,
                       help="Path to agent's workspace")
    parser.add_argument("--groundtruth_workspace", required=False,
                       help="Path to ground truth workspace (optional)")
    parser.add_argument("--res_log_file", required=False,
                       help="Path to result log file (optional)")
    parser.add_argument("--launch_time", required=False,
                       help="Launch time (optional)")
    args = parser.parse_args()

    try:
        evaluator = StockAlertEvaluator(args.agent_workspace)
        results = evaluator.run_evaluation()

        # Write results to log file if specified
        if args.res_log_file:
            # Write evaluation results to a separate file, not the trajectory file
            eval_temp_file = os.path.join(os.path.dirname(args.res_log_file), "eval_temp.json")
            with open(eval_temp_file, 'w', encoding='utf-8') as f:
                json.dump(results, f, ensure_ascii=False, indent=2)

        # Exit with appropriate code
        success = results["overall"]["passed"]
        sys.exit(0 if success else 1)

    except Exception as e:
        print(f"❌ Critical evaluation error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()