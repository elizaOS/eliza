"""
Remote Check Module - Check WooCommerce and Email Sending (supports local database)
"""

import os
import sys
import json
from datetime import datetime
from typing import Dict, List, Tuple, Optional
from pathlib import Path

# Add project path
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
sys.path.insert(0, task_dir)

REMOTE_API_AVAILABLE = False

def check_remote(agent_workspace: str, groundtruth_workspace: str, res_log: Dict,
                 woocommerce_db=None, email_db=None, groundtruth_metadata=None) -> Tuple[bool, str]:
    """
    Check service status - WooCommerce Product Categories, email sending
    Supports both local database and remote API modes

    Args:
        agent_workspace: Agent workspace path
        groundtruth_workspace: Ground truth workspace path
        res_log: Execution log
        woocommerce_db: WooCommerce local database instance (optional)
        email_db: Email local database instance (optional)
        groundtruth_metadata: Generated metadata (optional)

    Returns:
        (whether check passed, error message)
    """
    
    # Determine which mode to use
    use_local_db = (woocommerce_db is not None and email_db is not None)

    if use_local_db:
        print("Using local database mode for checking...")
        return check_with_local_db(agent_workspace, groundtruth_workspace,
                                   woocommerce_db, email_db, groundtruth_metadata)
    elif REMOTE_API_AVAILABLE:
        print("Using remote API mode for checking...")
        return check_with_remote_api(agent_workspace, groundtruth_workspace, res_log)
    else:
        return False, "Neither local database nor remote API is available"


def check_with_local_db(agent_workspace: str, groundtruth_workspace: str,
                        woocommerce_db, email_db, groundtruth_metadata=None) -> Tuple[bool, str]:
    """Check using local database"""
    
    try:
        # Display metadata information (if available)
        if groundtruth_metadata:
            print("\nGroundtruth metadata information:")
            gen_params = groundtruth_metadata.get('generation_params', {})
            print(f"   Expected low-selling products: {gen_params.get('num_low_selling', 'N/A')} items")
            print(f"   Expected normal products: {gen_params.get('num_normal_selling', 'N/A')} items")
            print(f"   Number of subscribers: {gen_params.get('num_subscribers', 'N/A')} items")

            # Display expected low-selling product names (first 5)
            expected_low_selling = groundtruth_metadata.get('low_selling_products', [])
            if expected_low_selling:
                print(f"\n   Expected low-selling products list (total {len(expected_low_selling)}):")
                for idx, name in enumerate(expected_low_selling[:5], 1):
                    print(f"      {idx}. {name}")
                if len(expected_low_selling) > 5:
                    print(f"      ... and {len(expected_low_selling) - 5} more")
        
        # Check 1: Product Categories and movement
        print("\n  Checking Product Categories and movement...")
        category_pass, category_msg = check_product_categories_local(woocommerce_db, groundtruth_metadata)
        if not category_pass:
            return False, f"Product Categories check failed: {category_msg}"
        else:
            print(f"    {category_msg}")
        
        # Blog post check skipped (WooCommerce does not manage WordPress blog)
        blog_msg = "Blog post publishing check skipped (WooCommerce does not manage WordPress blog)"
        print(f"\n    {blog_msg}")
        
        # Check 2: Email sending
        print("  Checking email sending...")
        email_pass, email_msg = check_email_sending_local(agent_workspace, woocommerce_db, email_db)
        if not email_pass:
            return False, f"Email sending check failed: {email_msg}"
        else:
            print(f"    {email_msg}")

        print("Local database check all passed")
        return True, f"Check passed: {category_msg}; {email_msg}"

    except Exception as e:
        import traceback
        traceback.print_exc()
        return False, f"Error during local database check: {str(e)}"


def check_with_remote_api(agent_workspace: str, groundtruth_workspace: str,
                          res_log: Dict) -> Tuple[bool, str]:
    """Check using remote API (backward compatible)"""
    
    try:
        # Initialize WooCommerce client
        site_url = all_token_key_session.woocommerce_site_url
        consumer_key = all_token_key_session.woocommerce_api_key
        consumer_secret = all_token_key_session.woocommerce_api_secret

        if not all([site_url, consumer_key, consumer_secret]):
            return False, "WooCommerce API configuration incomplete"
        
        wc_client = WooCommerceClient(site_url, consumer_key, consumer_secret)

        # Check 1: Product Categories and movement
        print("  Checking Product Categories and movement...")
        category_pass, category_msg = check_product_categories_remote(wc_client)
        if not category_pass:
            return False, f"Product Categories check failed: {category_msg}"
        else:
            print(f"    {category_msg}")

        # Blog post check skipped
        blog_msg = "Blog post publishing check skipped (WooCommerce does not manage WordPress blog)"
        print(f"\n    {blog_msg}")

        # Check 2: Email sending
        print("  Checking email sending...")
        email_pass, email_msg = check_email_sending_remote(agent_workspace, wc_client)
        if not email_pass:
            return False, f"Email sending check failed: {email_msg}"
        else:
            print(f"    {email_msg}")

        print("Remote API check all passed")
        return True, f"Check passed: {category_msg}; {email_msg}"

    except Exception as e:
        return False, f"Error during remote API check: {str(e)}"


def get_low_selling_products_local(woocommerce_db) -> Tuple[List[Dict], List[Dict]]:
    """Get low-selling products from local database"""
    
    all_products = list(woocommerce_db.products.values())
    current_date = datetime.now()
    low_selling_products = []
    other_products = []

    for product in all_products:
        # Calculate days in stock
        date_created_str = product.get('date_created', '')
        if not date_created_str:
            continue
        
        try:
            date_created = datetime.fromisoformat(date_created_str.replace('Z', '+00:00'))
            days_in_stock = (current_date - date_created.replace(tzinfo=None)).days
        except:
            continue
        
        # Get 30-day sales (from meta_data or direct field)
        sales_30_days = 0
        meta_data = product.get('meta_data', [])
        for meta in meta_data:
            if meta.get('key') in ['sales_last_30_days', '_sales_last_30_days']:
                try:
                    sales_30_days = int(meta.get('value', 0))
                    break
                except (ValueError, TypeError):
                    continue
        
        # If not in meta_data, check if there's a direct field
        if sales_30_days == 0 and 'sales_last_30_days' in product:
            try:
                sales_30_days = int(product.get('sales_last_30_days', 0))
            except:
                pass
        
        # Get price information
        product_name = product.get('name', '')
        regular_price = float(product.get('regular_price', 0)) if product.get('regular_price') else 0.0
        sale_price = float(product.get('sale_price', 0)) if product.get('sale_price') else regular_price

        # Calculate discount rate (discount percentage)
        # discount_rate = (regular_price - sale_price) / regular_price
        # Example: original price $100, current price $80, discount_rate=0.2 (20% off)
        discount_rate = (regular_price - sale_price) / regular_price if regular_price > 0 else 0.0
        
        item = {
            'product': product,
            'name': product_name,
            'regular_price': regular_price,
            'sale_price': sale_price,
            'days_in_stock': days_in_stock,
            'sales_30_days': sales_30_days,
            'discount_rate': discount_rate
        }
        
        # Determine if it's a low-selling product (in stock >90 days, 30-day sales <10)
        if days_in_stock > 90 and sales_30_days < 10:
            low_selling_products.append(item)
        else:
            other_products.append(item)
    
    # Sort: 1. Days in stock from most to least (entry time from earliest to latest) 2. Discount rate from low to high
    # discount_rate = (regular_price - sale_price) / regular_price
    # Higher value means bigger discount, sorting from low to high = smaller discount first
    low_selling_products.sort(key=lambda x: (-x['days_in_stock'], x['discount_rate']))

    # Debug info: display sorted product list
    if low_selling_products:
        print(f"\nLow-selling products sorted results (total {len(low_selling_products)}):")
        print("=" * 80)
        for idx, item in enumerate(low_selling_products, 1):
            print(f"{idx}. {item['name']}")
            print(f"   Days in stock: {item['days_in_stock']} days (earlier creation date means more days)")
            print(f"   30-day sales: {item['sales_30_days']}")
            print(f"   Original price: ${item['regular_price']:.2f}, Current price: ${item['sale_price']:.2f}")
            discount_pct = item['discount_rate'] * 100
            print(f"   Discount rate: {item['discount_rate']:.3f} ({discount_pct:.1f}% off)")
        print("=" * 80)
    
    return low_selling_products, other_products


def check_product_categories_local(woocommerce_db, groundtruth_metadata=None) -> Tuple[bool, str]:
    """Check Product Categories and low-selling product movement (local database version)"""
    
    try:
        # Get low-selling products
        low_selling_products, other_products = get_low_selling_products_local(woocommerce_db)

        # If groundtruth metadata available, compare
        if groundtruth_metadata:
            expected_low_selling_names = set(groundtruth_metadata.get('low_selling_products', []))
            actual_low_selling_names = set(item['name'] for item in low_selling_products)

            print(f"\nComparing expected vs actual low-selling products:")
            print(f"   Expected: {len(expected_low_selling_names)} items")
            print(f"   Actually identified: {len(actual_low_selling_names)} items")

            # Check if consistent
            if expected_low_selling_names != actual_low_selling_names:
                missing = expected_low_selling_names - actual_low_selling_names
                extra = actual_low_selling_names - expected_low_selling_names

                if missing:
                    print(f"   Missing low-selling products: {missing}")
                if extra:
                    print(f"   Extra identified products: {extra}")

                print(f"   Note: Product data may have changed during task execution")
            else:
                print(f"   Identification results match expected exactly")
        
        # Get Product Categories
        categories = list(woocommerce_db.categories.values())

        # Find Outlet category
        outlet_category = None
        outlet_names = ["Outlet/Clearance", "Outlet", "Clearance"]

        for category in categories:
            if category.get('name', '') in outlet_names:
                outlet_category = category
                break

        if not outlet_category:
            return False, "Outlet/Clearance category not found"

        print(f"Found Outlet category: {outlet_category.get('name')}")
        outlet_category_id = outlet_category.get('id')

        # Check low-selling product status
        total_low_selling = len(low_selling_products)
        low_selling_in_outlet = 0
        low_selling_not_in_outlet = []
        normal_selling_in_outlet = []

        # Check if each low-selling product is in Outlet category
        for item in low_selling_products:
            product = item['product']
            product_name = item['name']
            
            product_categories = product.get('categories', [])
            is_in_outlet = any(cat.get('id') == outlet_category_id for cat in product_categories)
            
            if is_in_outlet:
                low_selling_in_outlet += 1
            else:
                low_selling_not_in_outlet.append(product_name)
        
        # Check if any non-low-selling products were incorrectly placed in Outlet category
        all_products = list(woocommerce_db.products.values())
        for product in all_products:
            product_categories = product.get('categories', [])
            is_in_outlet = any(cat.get('id') == outlet_category_id for cat in product_categories)

            if is_in_outlet:
                # Check if it's a low-selling product
                is_low_selling = any(item['name'] == product.get('name') for item in low_selling_products)

                if not is_low_selling:
                    # Calculate the actual data for this product
                    date_created_str = product.get('date_created', '')
                    if date_created_str:
                        try:
                            date_created = datetime.fromisoformat(date_created_str.replace('Z', '+00:00'))
                            days_in_stock = (datetime.now() - date_created.replace(tzinfo=None)).days
                        except:
                            days_in_stock = 0
                    else:
                        days_in_stock = 0
                    
                    sales_30_days = 0
                    meta_data = product.get('meta_data', [])
                    for meta in meta_data:
                        if meta.get('key') in ['sales_last_30_days', '_sales_last_30_days']:
                            try:
                                sales_30_days = int(meta.get('value', 0))
                                break
                            except:
                                pass
                    
                    normal_selling_in_outlet.append({
                        'name': product.get('name', 'Unknown'),
                        'days_in_stock': days_in_stock,
                        'sales_30_days': sales_30_days
                    })
        
        # Check results
        if total_low_selling == 0:
            return False, "No qualifying low-selling products found (in stock >90 days, 30-day sales <10)"

        if normal_selling_in_outlet:
            error_details = []
            for item in normal_selling_in_outlet:
                error_details.append(f"{item['name']} (in stock {item['days_in_stock']} days, 30-day sales {item['sales_30_days']})")
            return False, f"Found {len(normal_selling_in_outlet)} non-low-selling products incorrectly placed in Outlet category: {'; '.join(error_details)}"

        if low_selling_in_outlet == 0:
            return False, f"No low-selling products were moved to Outlet category. Found {total_low_selling} low-selling products, but none are in Outlet category"

        if low_selling_in_outlet < total_low_selling:
            missing_count = total_low_selling - low_selling_in_outlet
            return False, f"Only some low-selling products were moved to Outlet category. Total {total_low_selling} low-selling products, only {low_selling_in_outlet} in Outlet category, missing {missing_count}. Products not moved: {', '.join(low_selling_not_in_outlet)}"

        return True, f"All {total_low_selling} low-selling products have been correctly moved to Outlet category, and no non-low-selling products are in Outlet category"

    except Exception as e:
        import traceback
        traceback.print_exc()
        return False, f"Product Categories check error: {str(e)}"


def get_attachment_content(attachment: Dict, agent_workspace: str = None,
                          email_db=None, user_email: str = None, email_id: str = None) -> Optional[str]:
    """Get attachment content (supports multiple sources)

    Args:
        attachment: Attachment dictionary, may contain 'content', 'path', 'filename' and other fields
        agent_workspace: Agent workspace path (for finding attachment files)
        email_db: Email database instance
        user_email: User email address
        email_id: Email ID

    Returns:
        Attachment content string, returns None if retrieval fails
    """
    try:
        # Method 1: Read directly from content field
        content = attachment.get('content', '')
        if content:
            print(f"   Reading attachment content from content field")
            return content

        # Method 2: Read file from path field
        path = attachment.get('path', '')
        if path and os.path.exists(path):
            print(f"   Reading attachment from path: {path}")
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()

        # Method 3: Check if there's base64 encoded content
        for key in ['data', 'base64', 'content_base64']:
            if key in attachment:
                print(f"   Attempting to decode from {key} field")
                try:
                    import base64
                    decoded = base64.b64decode(attachment[key])
                    return decoded.decode('utf-8')
                except Exception as e:
                    print(f"   base64 decoding failed: {e}")

        # Method 4: Find by filename in agent workspace
        filename = attachment.get('filename', '')
        if filename and agent_workspace:
            # Try to find in agent workspace root directory
            possible_paths = [
                os.path.join(agent_workspace, filename),
                os.path.join(agent_workspace, 'attachments', filename),
            ]

            # If email database and user info available, also try user attachment directory
            if email_db and user_email:
                user_dir = email_db._get_user_data_dir(user_email)
                possible_paths.extend([
                    os.path.join(user_dir, 'attachments', filename),
                    os.path.join(user_dir, 'attachments', email_id or '', filename) if email_id else None,
                ])

            # Try all possible paths
            for possible_path in possible_paths:
                if possible_path and os.path.exists(possible_path):
                    print(f"   Reading attachment from agent workspace: {possible_path}")
                    with open(possible_path, 'r', encoding='utf-8') as f:
                        return f.read()
                elif possible_path:
                    print(f"   Path does not exist: {possible_path}")

        print(f"   Unable to get attachment content")
        print(f"   Attachment fields: {list(attachment.keys())}")
        if agent_workspace:
            print(f"   Tried to find in agent workspace: {filename}")
        return None

    except Exception as e:
        print(f"   Failed to get attachment content: {e}")
        import traceback
        traceback.print_exc()
        return None


def parse_csv_attachment(attachment_content: str) -> List[Dict]:
    """Parse CSV attachment content

    Args:
        attachment_content: CSV file content string

    Returns:
        List[Dict]: Product list, each product contains name, original_price, promotional_price, discount_ratio
    """
    import csv
    import io
    
    if not attachment_content:
        print("CSV content is empty")
        return []

    lines = attachment_content.strip().split('\n')
    if not lines:
        print("CSV content has no lines")
        return []
    
    try:
        # Use csv.DictReader to parse
        reader = csv.DictReader(io.StringIO(attachment_content))
        products = []

        for row_num, row in enumerate(reader, 1):
            if not row.get('Product Name'):  # Skip empty rows
                continue

            try:
                # Handle price: may contain dollar sign and comma (e.g., "$1,234.56")
                def parse_price(price_str):
                    if not price_str:
                        return 0.0
                    # Remove dollar sign, comma and spaces
                    price_str = str(price_str).strip().replace('$', '').replace(',', '')
                    return float(price_str)

                # Handle discount ratio: may contain percent sign (e.g., "44.77%")
                discount_ratio_str = row.get('Discount Ratio', '0').strip()
                if discount_ratio_str.endswith('%'):
                    # Remove percent sign
                    discount_ratio = float(discount_ratio_str.rstrip('%'))
                else:
                    discount_ratio = float(discount_ratio_str)
                
                products.append({
                    'name': row.get('Product Name', '').strip(),
                    'original_price': parse_price(row.get('Original Price', 0)),
                    'promotional_price': parse_price(row.get('Promotional Price', 0)),
                    'discount_ratio': discount_ratio
                })
            except (ValueError, TypeError) as e:
                print(f"Failed to parse CSV row {row_num}: {e}")
                print(f"   Row content: {row}")
                continue

        return products

    except Exception as e:
        print(f"CSV parsing failed: {e}")
        import traceback
        traceback.print_exc()
        return []


def validate_csv_products(csv_products: List[Dict], expected_low_selling: List[Dict]) -> Tuple[bool, str]:
    """
    Validate whether products in CSV meet requirements

    Requirements:
    1. All products in CSV must be low-selling products
    2. Sorted by entry time from earliest to latest (days from most to least)
    3. If entry time is the same, sort by discount rate from low to high
    4. Price and discount rate must match
    """

    # Create low-selling product mapping (by name)
    expected_products_map = {item['name']: item for item in expected_low_selling}

    print(f"\n   Validating CSV products...")

    # 1. Check product count
    if len(csv_products) != len(expected_low_selling):
        return False, f"CSV product count ({len(csv_products)}) does not match expected low-selling product count ({len(expected_low_selling)})"

    # 2. Check if each product is a low-selling product
    for idx, csv_prod in enumerate(csv_products, 1):
        prod_name = csv_prod['name']

        if prod_name not in expected_products_map:
            return False, f"Product '{prod_name}' in CSV is not a low-selling product"

        expected_prod = expected_products_map[prod_name]

        # Check price
        if abs(csv_prod['original_price'] - expected_prod['regular_price']) > 0.01:
            return False, f"Product '{prod_name}' original price mismatch: CSV={csv_prod['original_price']}, expected={expected_prod['regular_price']}"

        if abs(csv_prod['promotional_price'] - expected_prod['sale_price']) > 0.01:
            return False, f"Product '{prod_name}' promotional price mismatch: CSV={csv_prod['promotional_price']}, expected={expected_prod['sale_price']}"

        # Check discount rate (allow some tolerance due to rounding)
        expected_discount_pct = expected_prod['discount_rate'] * 100
        if abs(csv_prod['discount_ratio'] - expected_discount_pct) > 0.2:
            return False, f"Product '{prod_name}' discount rate mismatch: CSV={csv_prod['discount_ratio']}, expected={expected_discount_pct:.3f}"

    # 3. Check sorting
    # Sort by entry time from earliest to latest (days from most to least), same then by discount rate from low to high
    print(f"\n   Validating sorting...")
    print(f"   Sorting rule: 1. Entry time from earliest to latest (days from most to least) 2. Same time then by discount rate from low to high")
    
    for idx in range(len(csv_products)):
        csv_name = csv_products[idx]['name']
        expected_name = expected_low_selling[idx]['name']

        if csv_name != expected_name:
            # Display sorting error details
            print(f"\n   Sorting error at position {idx + 1}:")
            print(f"      CSV product: {csv_name}")
            print(f"      Expected product: {expected_name}")

            # Display expected sorting
            print(f"\n   Expected sorting (first 5):")
            for i, item in enumerate(expected_low_selling[:5], 1):
                print(f"      {i}. {item['name']}")
                print(f"         In stock {item['days_in_stock']} days, discount rate {item['discount_rate']:.3f}")

            # Display actual sorting
            print(f"\n   CSV sorting (first 5):")
            for i, csv_prod in enumerate(csv_products[:5], 1):
                prod_name = csv_prod['name']
                if prod_name in expected_products_map:
                    expected_item = expected_products_map[prod_name]
                    print(f"      {i}. {prod_name}")
                    print(f"         In stock {expected_item['days_in_stock']} days, discount rate {expected_item['discount_rate']:.3f}")

            return False, f"Product sorting error: position {idx + 1} should be '{expected_name}', but CSV has '{csv_name}'"

    print(f"   All products validated")
    print(f"   Sorting correct")

    return True, f"CSV contains all {len(csv_products)} low-selling products, prices and sorting are correct"


def check_email_sending_local(agent_workspace: str, woocommerce_db, email_db) -> Tuple[bool, str]:
    """Check email sending (local database version) - Check CSV attachment from recipient's perspective"""
    
    try:
        # Get low-selling products
        low_selling_products, _ = get_low_selling_products_local(woocommerce_db)

        if not low_selling_products:
            return False, "No low-selling products found, cannot generate expected email content"

        print(f"Found {len(low_selling_products)} low-selling products for promotion")

        # Read subscriber information
        subscriber_path = os.path.join(agent_workspace, 'subscriber.json')
        if not os.path.exists(subscriber_path):
            return False, f"Subscriber configuration file not found: {subscriber_path}"

        with open(subscriber_path, 'r', encoding='utf-8') as f:
            subscriber_config = json.load(f)

        subscribers = subscriber_config.get('subscriber_list', [])
        if not subscribers:
            return False, "Subscriber information not found"

        print(f"\nNeed to check emails for {len(subscribers)} subscribers")

        # Check emails from recipient's perspective
        matched_recipients = set()
        total_checked_subscribers = 0

        print(f"\nChecking emails from recipient's perspective (avoiding mass email duplication issues)...")
        
        for subscriber in subscribers:
            subscriber_email = subscriber.get('email', '').lower()
            subscriber_name = subscriber.get('name', 'Unknown')

            if not subscriber_email:
                continue

            total_checked_subscribers += 1

            print(f"\nChecking subscriber #{total_checked_subscribers}: {subscriber_name} ({subscriber_email})")

            # Check if this subscriber is in the email database
            if subscriber_email not in email_db.users:
                print(f"   Subscriber not in email database (may be external mailbox)")
                continue

            # Read subscriber's emails
            user_dir = email_db._get_user_data_dir(subscriber_email)
            emails_file = os.path.join(user_dir, "emails.json")

            if not os.path.exists(emails_file):
                print(f"   Email file does not exist: {emails_file}")
                continue

            try:
                with open(emails_file, 'r', encoding='utf-8') as f:
                    user_emails = json.load(f)

                print(f"   Total emails: {len(user_emails)}")
            except Exception as e:
                print(f"   Failed to read email file: {e}")
                continue

            # Find emails with CSV attachment in INBOX
            found_valid_email = False
            inbox_count = 0
            
            for email_id, email_data in user_emails.items():
                if email_data.get('folder') != 'INBOX':
                    continue

                inbox_count += 1

                # Get email information
                from_addr = email_data.get('from', '')
                subject = email_data.get('subject', '')
                attachments = email_data.get('attachments', [])

                # Find discount_products.csv attachment
                csv_attachment = None
                for attachment in attachments:
                    filename = attachment.get('filename', '')
                    if filename == 'discount_products.csv':
                        csv_attachment = attachment
                        break

                if not csv_attachment:
                    continue

                print(f"   Found email with CSV attachment")
                print(f"      From: {from_addr}")
                print(f"      Subject: {subject}")

                # Parse CSV content
                try:
                    # Get CSV attachment content
                    csv_content = get_attachment_content(
                        csv_attachment,
                        agent_workspace=agent_workspace,
                        email_db=email_db,
                        user_email=subscriber_email,
                        email_id=email_id
                    )

                    if not csv_content:
                        print(f"      CSV content is empty or cannot be retrieved")
                        continue

                    print(f"      CSV content length: {len(csv_content)} characters")

                    # Parse CSV
                    csv_products = parse_csv_attachment(csv_content)

                    if not csv_products:
                        print(f"      CSV parsing failed")
                        continue

                    print(f"      CSV contains {len(csv_products)} products")

                    # Display first few products
                    print(f"      CSV product examples (first 3):")
                    for idx, prod in enumerate(csv_products[:3], 1):
                        print(f"         {idx}. {prod['name']}")
                        print(f"            Original price: ${prod['original_price']:.2f}, Promotional price: ${prod['promotional_price']:.2f}")
                        print(f"            Discount ratio: {prod['discount_ratio']:.1f}%")

                    # Validate products in CSV
                    is_valid, error_msg = validate_csv_products(csv_products, low_selling_products)

                    if is_valid:
                        matched_recipients.add(subscriber_email)
                        found_valid_email = True
                        print(f"      CSV validation passed!")
                        break  # Found one valid email is enough
                    else:
                        print(f"      CSV validation failed: {error_msg}")

                except Exception as e:
                    print(f"      Failed to process CSV: {str(e)}")
                    import traceback
                    traceback.print_exc()

            if inbox_count > 0:
                print(f"   INBOX contains {inbox_count} emails total")

            if not found_valid_email:
                print(f"   No email with valid CSV attachment found")
        
        # Final check result summary
        print(f"\n" + "=" * 70)
        print(f"Email check result summary:")
        print(f"   Total subscribers checked: {total_checked_subscribers}/{len(subscribers)}")
        print(f"   Subscribers validated: {len(matched_recipients)}/{len(subscribers)}")

        # Check results
        subscriber_map = {sub.get('email', '').lower(): sub.get('name', '') for sub in subscribers}
        missing_recipients = []
        for subscriber in subscribers:
            subscriber_email = subscriber.get('email', '').lower()
            if subscriber_email and subscriber_email not in matched_recipients:
                subscriber_name = subscriber.get('name', 'Unknown')
                missing_recipients.append(f"{subscriber_name} ({subscriber_email})")

        if matched_recipients:
            print(f"\nValidated subscribers:")
            for email in sorted(matched_recipients):
                subscriber_name = subscriber_map.get(email, 'Unknown')
                print(f"   - {subscriber_name} ({email})")

        if missing_recipients:
            print(f"\nSubscribers not validated:")
            for recipient in missing_recipients:
                print(f"   - {recipient}")

        print("=" * 70)

        if not missing_recipients:
            return True, f"All {len(subscribers)} subscribers received promotional emails with correct CSV attachments, CSV contains {len(low_selling_products)} low-selling products"
        else:
            return False, f"The following subscribers did not receive matching emails or CSV content is incorrect: {', '.join(missing_recipients)}"

    except Exception as e:
        import traceback
        traceback.print_exc()
        return False, f"Email sending check error: {str(e)}"


# ========== Remote API version functions (backward compatible) ==========

def check_product_categories_remote(wc_client) -> Tuple[bool, str]:
    """Check Product Categories (remote API version)"""
    # Keep original remote API implementation
    pass


def check_email_sending_remote(agent_workspace: str, wc_client) -> Tuple[bool, str]:
    """Check email sending (remote API version)"""
    # Keep original remote API implementation
    pass
