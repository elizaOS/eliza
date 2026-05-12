import requests
import json
import time
from datetime import datetime, timedelta
from typing import Dict, List
import sys
import os
import random

# Dynamically add current directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
project_root = os.path.dirname(os.path.dirname(os.path.dirname(task_dir)))
sys.path.insert(0, project_root)
sys.path.insert(0, task_dir)
sys.path.insert(0, current_dir)

from utils.app_specific.woocommerce.client import WooCommerceClient
from utils.app_specific.poste.local_email_manager import LocalEmailManager

class TestProductSetup:
    """Test product setup tool - Create test data for evaluation"""

    def __init__(self, site_url: str, consumer_key: str, consumer_secret: str):
        """
        Initialize test product setup tool

        Args:
            site_url: WooCommerce site URL
            consumer_key: WooCommerce API consumer key
            consumer_secret: WooCommerce API consumer secret
        """
        self.wc_client = WooCommerceClient(site_url, consumer_key, consumer_secret)
        self.created_products = []

    def clear_all_products(self) -> Dict:
        """
        Clear all products and categories in the store

        Returns:
            Clearing result dictionary
        """
        print("🧹 Starting to clear all products in the store...")

        try:
            # 1. Get all products
            print("📦 Getting all products...")
            all_products = self.wc_client.get_all_products()

            deleted_products = 0
            failed_products = 0

            # 2. Delete all products
            if all_products:
                print(f"🗑️ Preparing to delete {len(all_products)} products...")

                success, result = self.wc_client.batch_delete_products(all_products)
                if success:
                    print(f"✅ Deleted products: {len(all_products)} products")
                else:
                    print(f"❌ Failed to delete products: {result}")
                    return {"success": False, "deleted_count": 0, "failed_count": len(all_products)}
            else:
                print("📦 No products in the store to delete")

            # 3. Get and delete custom categories
            print("🏷️ Clearing Product Categories...")
            success, categories = self.wc_client.get_product_categories()

            deleted_categories = 0
            failed_categories = 0

            if success and categories:
                for category in categories:
                    category_name = category.get('name', '')
                    category_id = category.get('id')

                    # Only delete test-related categories, avoid deleting system default categories
                    if category_name != "Uncategorized":  # Empty categories can also be deleted
                        try:
                            success, result  = self.wc_client.delete_category(category_id, force=True)

                            if success:
                                print(f"   ✅ Deleted category: {category_name} (ID: {category_id})")
                                deleted_categories += 1
                            else:
                                print(f"   ⚠️ Skipped category: {category_name} (may be a system default category)")

                        except Exception as e:
                            print(f"   ❌ Error deleting category {category_name}: {e}")
                            failed_categories += 1

                        time.sleep(0.3)

            # 4. Generate clearing report
            clear_result = {
                "success": failed_products == 0 and failed_categories == 0,
                "products": {
                    "total_found": len(all_products) if all_products else 0,
                    "deleted": deleted_products,
                    "failed": failed_products
                },
                "categories": {
                    "deleted": deleted_categories,
                    "failed": failed_categories
                },
                "timestamp": datetime.now().isoformat()
            }

            print(f"\n📊 Clearing complete:")
            print(f"   Products: deleted {deleted_products}, failed {failed_products}")
            print(f"   Categories: deleted {deleted_categories}, failed {failed_categories}")

            if clear_result["success"]:
                print("✅ Store clearing successful!")
            else:
                print("⚠️ Store clearing partially complete, some items failed to clear")

            return clear_result

        except Exception as e:
            error_result = {
                "success": False,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }
            print(f"❌ Error during clearing: {e}")
            return error_result

    def create_test_products(self) -> Dict:
        """
        Create test products
        Including:
        1. Low-selling products (in stock >90 days, 30-day sales <10)
        2. Normal-selling products (control group)

        Returns:
            Creation result dictionary
        """
        print("🛒 Starting to create test categories and products...")

        # Define test product data
        test_products = self._generate_test_product_data()

        created_count = 0
        failed_count = 0
        success, result = self.wc_client.batch_create_products(test_products)
        if success:
            print(f"✅ Created products: {len(test_products)} products")
        else:
            print(f"❌ Failed to create products: {result}")
            return {"success": False, "created_count": 0, "failed_count": len(test_products)}

        setup_result = {
            "success": failed_count == 0,
            "created_count": created_count,
            "failed_count": failed_count,
            "created_products": self.created_products,
            "low_selling_expected": len([p for p in test_products if self._is_low_selling_product(p)]),
            "normal_selling_expected": len([p for p in test_products if not self._is_low_selling_product(p)])
        }

        print(f"📊 Product creation complete:")
        print(f"   Expected low-selling products: {setup_result['low_selling_expected']}")
        print(f"   Expected normal products: {setup_result['normal_selling_expected']}")

        return setup_result

    def _generate_test_product_data(self) -> List[Dict]:
        """Generate test product data"""
        current_date = datetime.now()
        products = []

        # Low-selling products (should be filtered out)
        low_selling_products = [
            {
                "name": "Phone case iPhone X",
                "type": "simple",
                "regular_price": "29.99",
                "sale_price": "19.99",
                "stock_quantity": 50,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=120)).isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "low_selling"},
                    {"key": "sales_last_30_days", "value": "3"},
                    {"key": "_sales_last_30_days", "value": "3"},
                    {"key": "total_sales", "value": "15"},
                    {"key": "_total_sales", "value": "15"}
                ]
            },
            {
                "name": "Bluetooth Headphone",
                "type": "simple",
                "regular_price": "89.99",
                "sale_price": "59.99",
                "stock_quantity": 25,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=150)).isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "low_selling"},
                    {"key": "sales_last_30_days", "value": "2"},
                    {"key": "_sales_last_30_days", "value": "2"},
                    {"key": "total_sales", "value": "8"},
                    {"key": "_total_sales", "value": "8"}
                ]
            },
            {
                "name": "Old Sneakers 2022",
                "type": "simple",
                "regular_price": "159.99",
                "sale_price": "72.99",
                "stock_quantity": 30,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=200)).isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "low_selling"},
                    {"key": "sales_last_30_days", "value": "5"},
                    {"key": "_sales_last_30_days", "value": "5"},
                    {"key": "total_sales", "value": "22"},
                    {"key": "_total_sales", "value": "22"}
                ]
            },
            {
                "name": "Tablet Case",
                "type": "simple",
                "regular_price": "38.99",
                "sale_price": "24.99",
                "stock_quantity": 40,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=180)).isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "low_selling"},
                    {"key": "sales_last_30_days", "value": "1"},
                    {"key": "_sales_last_30_days", "value": "1"},
                    {"key": "total_sales", "value": "6"},
                    {"key": "_total_sales", "value": "6"}
                ]
            },
            {
                "name": "Charger v11",
                "type": "simple",
                "regular_price": "49.99",
                "sale_price": "34.99",
                "stock_quantity": 60,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=250)).isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "low_selling"},
                    {"key": "sales_last_30_days", "value": "4"},
                    {"key": "_sales_last_30_days", "value": "4"},
                    {"key": "total_sales", "value": "18"},
                    {"key": "_total_sales", "value": "18"}
                ]
            }
        ]

        # Normal-selling products (should not be filtered)
        normal_selling_products = [
            {
                "name": "iPhone 15 Phone Case",
                "type": "simple",
                "regular_price": "39.99",
                "sale_price": "36.99",  # Small discount: about 7.5% off
                "stock_quantity": 100,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=60)).isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "normal_selling"},
                    {"key": "sales_last_30_days", "value": "45"},
                    {"key": "_sales_last_30_days", "value": "45"},
                    {"key": "total_sales", "value": "120"},
                    {"key": "_total_sales", "value": "120"}
                ]
            },
            {
                "name": "Wireless Charger",
                "type": "simple",
                "regular_price": "79.99",
                # No discount, keep original price
                "stock_quantity": 80,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=30)).isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "normal_selling"},
                    {"key": "sales_last_30_days", "value": "25"},
                    {"key": "_sales_last_30_days", "value": "25"},
                    {"key": "total_sales", "value": "35"},
                    {"key": "_total_sales", "value": "35"}
                ]
            },
            {
                "name": "Nike Sneakers",
                "type": "simple",
                "regular_price": "199.99",
                "sale_price": "189.99",  # Small discount: about 5% off
                "stock_quantity": 50,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": (current_date - timedelta(days=200)).isoformat(),  # In stock for a long time, but good sales
                "meta_data": [
                    {"key": "product_type", "value": "normal_selling"},
                    {"key": "sales_last_30_days", "value": "15"},  # 30-day sales >=10, does not meet filter criteria
                    {"key": "_sales_last_30_days", "value": "15"},
                    {"key": "total_sales", "value": "180"},
                    {"key": "_total_sales", "value": "180"}
                ]
            }
        ]

        # Distractor items
        extra_normal_selling_products = []
        for id in range(10,400): # Create ~400 new products
            regprice = 599.99+2*id # Ensure prices don't conflict with above
            stock_quantity = random.randint(10, 200)
            date_created = (current_date - timedelta(days=random.randint(10, 200))).isoformat()
            sales_30_days = random.randint(11, 200) # Definitely not promotional
            total_sales = sales_30_days + random.randint(11, 200)
            name = random.choice(["AOC", "Samsung", "LG", "Xiaomi", "Sony"]) + " " + random.choice(["Monitor", "Phone", "TV", "Laptop", "Tablet"]) + " v" + str(id)
            extra_normal_selling_products.append({
                "name": name,
                "type": "simple",
                "regular_price": str(regprice),
                "stock_quantity": stock_quantity,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": date_created,
                "meta_data": [
                    {"key": "product_type", "value": "low_selling"},
                    {"key": "sales_last_30_days", "value": str(sales_30_days)},
                    {"key": "_sales_last_30_days", "value": str(sales_30_days)},
                    {"key": "total_sales", "value": str(total_sales)},
                    {"key": "_total_sales", "value": str(total_sales)}
                ]
            })

        products.extend(low_selling_products)
        products.extend(normal_selling_products)
        products.extend(extra_normal_selling_products)

        random.shuffle(products)

        return products

    def _is_low_selling_product(self, product_data: Dict) -> bool:
        """Determine if it is a low-selling product"""
        # Check publish date
        date_created_str = product_data.get('date_created', '')
        if date_created_str:
            date_created = datetime.fromisoformat(date_created_str.replace('Z', ''))
            days_in_stock = (datetime.now() - date_created).days
        else:
            days_in_stock = 0

        # Check 30-day sales
        sales_30_days = 0
        meta_data = product_data.get('meta_data', [])
        for meta in meta_data:
            if meta.get('key') == 'sales_last_30_days':
                try:
                    sales_30_days = int(meta.get('value', 0))
                    break
                except (ValueError, TypeError):
                    continue

        return days_in_stock > 90 and sales_30_days < 10

    def cleanup_test_products(self) -> Dict:
        """Clean up test products"""
        print("🧹 Starting to clean up test products...")

        deleted_count = 0
        failed_count = 0

        for product in self.created_products:
            product_id = product.get('id')
            product_name = product.get('name')

            success, result = self.wc_client.delete_product(str(product_id), force=True)
            if success:
                print(f"✅ Deleted product: {product_name} (ID: {product_id})")
                deleted_count += 1
            else:
                print(f"❌ Failed to delete product: {product_name} - {result}")
                failed_count += 1

            time.sleep(0.3)

        cleanup_result = {
            "success": failed_count == 0,
            "deleted_count": deleted_count,
            "failed_count": failed_count
        }

        print(f"📊 Cleanup complete:")
        print(f"   Successfully deleted: {deleted_count} products")
        print(f"   Failed to delete: {failed_count} products")

        return cleanup_result

    def get_expected_results(self) -> Dict:
        """Get expected results for evaluation"""
        # Correctly extract product types
        low_selling_products = []
        normal_selling_products = []

        for product in self.created_products:
            product_type = product.get('type', 'unknown')
            if product_type == 'low_selling':
                low_selling_products.append(product)
            elif product_type == 'normal_selling':
                normal_selling_products.append(product)

        return {
            "expected_low_selling_count": len(low_selling_products),
            "expected_normal_count": len(normal_selling_products),
            "expected_low_selling_ids": [p.get('id') for p in low_selling_products],
            "expected_normal_ids": [p.get('id') for p in normal_selling_products],
            "total_test_products": len(self.created_products),
            "all_created_products": self.created_products
        }

    def clear_mailbox(self) -> Dict:
        """
        Clear mailbox using general email manager

        Returns:
            Dictionary with clearing results
        """
        print("📧 Starting mailbox clearing...")

        try:
            # Get email configuration from token session
            from token_key_session import all_token_key_session

            config_path = all_token_key_session.emails_config_file

            # Initialize email manager
            email_manager = LocalEmailManager(config_path, verbose=True)

            # Clear both INBOX and Sent folders
            folders_to_clear = ['INBOX', 'Sent']
            clear_results = {}

            for folder in folders_to_clear:
                print(f"🗂️ Clearing folder: {folder}")

                try:
                    if folder == 'INBOX':
                        email_manager.clear_all_emails('INBOX')
                        # Count remaining emails to verify
                        remaining_emails = email_manager.get_all_emails('INBOX')
                        clear_results[folder] = {
                            "success": len(remaining_emails) == 0,
                            "deleted_count": "cleared" if len(remaining_emails) == 0 else 0,
                            "message": f"Folder cleared, {len(remaining_emails)} emails remaining"
                        }
                    else:  # Sent folder
                        email_manager.clear_all_emails('Sent')
                        remaining_emails = email_manager.get_all_emails('Sent')
                        clear_results[folder] = {
                            "success": len(remaining_emails) == 0,
                            "deleted_count": "cleared" if len(remaining_emails) == 0 else 0,
                            "message": f"Folder cleared, {len(remaining_emails)} emails remaining"
                        }

                    print(f"   ✅ Folder {folder}: {clear_results[folder]['message']}")

                except Exception as e:
                    print(f"   ❌ Error clearing folder {folder}: {e}")
                    clear_results[folder] = {
                        "success": False,
                        "error": str(e),
                        "deleted_count": 0
                    }

            # Calculate total results
            all_success = all(result.get('success', False) for result in clear_results.values())

            final_result = {
                "success": all_success,
                "folders": clear_results,
                "timestamp": datetime.now().isoformat()
            }

            print(f"📊 Mailbox clearing complete")

            if all_success:
                print("✅ Mailbox clearing successful!")
            else:
                print("⚠️ Mailbox clearing partially completed")

            return final_result

        except Exception as e:
            error_result = {
                "success": False,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }
            print(f"❌ Error during mailbox clearing: {e}")
            return error_result

    def clear_blog_posts(self) -> Dict:
        """
        Clear blog posts

        Returns:
            Clearing result dictionary
        """
        print("📝 Starting to clear blog posts...")

        try:
            # Read configuration from token config file
            from token_key_session import all_token_key_session

            site_url = all_token_key_session.woocommerce_site_url
            consumer_key = all_token_key_session.woocommerce_api_key
            consumer_secret = all_token_key_session.woocommerce_api_secret

            wp_api_base = f"{site_url}/wp-json/wp/v2"
            wp_auth = requests.auth.HTTPBasicAuth(consumer_key, consumer_secret)

            # Get all posts
            print("📄 Getting all blog posts...")
            response = requests.get(
                f"{wp_api_base}/posts",
                auth=wp_auth,
                params={'per_page': 100, 'status': 'any'}
            )

            if response.status_code != 200:
                return {
                    "success": False,
                    "error": f"Unable to get blog posts: HTTP {response.status_code}",
                    "deleted_count": 0,
                    "timestamp": datetime.now().isoformat()
                }

            posts = response.json()
            deleted_count = 0
            failed_count = 0

            # if not posts:
            #     print("📭 No blog posts found to delete")
            #     return {
            #         "success": True,
            #         "deleted_count": 0,
            #         "timestamp": datetime.now().isoformat()
            #     }

            print(f"🗑️ Preparing to delete {len(posts)} blog posts...")

            for post in posts:
                post_id = post.get('id')
                post_title = post.get('title', {}).get('rendered', 'Unknown')

                try:
                    # Force delete post
                    delete_response = requests.delete(
                        f"{wp_api_base}/posts/{post_id}",
                        auth=wp_auth,
                        params={'force': True}
                    )

                    if delete_response.status_code in [200, 204]:
                        print(f"   ✅ Deleted post: {post_title} (ID: {post_id})")
                        deleted_count += 1
                    else:
                        print(f"   ❌ Failed to delete: {post_title} - HTTP {delete_response.status_code}")
                        failed_count += 1

                except Exception as e:
                    print(f"   ❌ Error deleting post {post_title}: {e}")
                    failed_count += 1

                time.sleep(0.3)  # Avoid API rate limiting

            blog_result = {
                "success": failed_count == 0,
                "deleted_count": deleted_count,
                "failed_count": failed_count,
                "total_found": len(posts),
                "timestamp": datetime.now().isoformat()
            }

            print(f"📊 Blog clearing complete:")
            print(f"   Successfully deleted: {deleted_count} posts")
            print(f"   Failed to delete: {failed_count} posts")

            if blog_result["success"]:
                print("✅ Blog clearing successful!")
            else:
                print("⚠️ Blog clearing partially complete, some posts failed to delete")

            return blog_result

        except Exception as e:
            error_result = {
                "success": False,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }
            print(f"❌ Error during blog clearing: {e}")
            return error_result


def main():
    """Main function - For running test data setup independently"""
    # Read configuration from token config file
    from token_key_session import all_token_key_session

    site_url = all_token_key_session.woocommerce_site_url
    consumer_key = all_token_key_session.woocommerce_api_key
    consumer_secret = all_token_key_session.woocommerce_api_secret

    print(f"🚀 Initializing test product setup tool: {site_url}")

    setup = TestProductSetup(site_url, consumer_key, consumer_secret)

    # 1. First clear mailbox
    print("\n" + "="*60)
    print("Step One: Clear mailbox")
    print("="*60)

    mailbox_result = setup.clear_mailbox()

    if not mailbox_result.get('success'):
        print("⚠️ Mailbox clearing not fully successful, subsequent operations failed...")
        print(f"Mailbox clearing details: {mailbox_result}")
        return False

    # NOTE: Previously I didn't know why it couldn't be cleared... now I know, WooCommerce doesn't manage WordPress, blogs are attached to WordPress...
    # # 2. Clear blog posts
    print("\n" + "="*60)
    print("Step Two: Clear blog posts - Cannot clear, skipping!")
    print("="*60)

    # blog_result = setup.clear_blog_posts()
    blog_result = {"status":"SKIPPED!"}

    # if not blog_result.get('success'):
    #     print("⚠️ Blog clearing not fully successful, but continuing with subsequent operations...")
    #     print(f"Blog clearing details: {blog_result}")

    # 3. Clear all products in the store
    print("\n" + "="*60)
    print("Step Three: Clear all existing products in the store")
    print("="*60)

    clear_result = setup.clear_all_products()

    if not clear_result.get('success'):
        print("⚠️ Product clearing not fully successful, not creating test products...")
        print(f"Clearing details: {clear_result}")
        return False

    # 3. Then create test products
    print("\n" + "="*60)
    print("Step Four: Create test products")
    print("="*60)

    result = setup.create_test_products()

    if result.get('success'):
        print("✅ Test product setup complete!")

        # Save expected results
        expected_results = setup.get_expected_results()
        with open(os.path.join(task_dir, 'groundtruth_workspace', 'expected_results.json'), 'w', encoding='utf-8') as f:
            json.dump(expected_results, f, indent=2, ensure_ascii=False)
        print("📄 Expected results saved to groundtruth_workspace/expected_results.json")

        # Save clearing results (including mailbox, blog, store clearing results)
        all_clear_results = {
            "mailbox_clear": mailbox_result,
            "blog_clear": blog_result,
            "store_clear": clear_result
        }
        with open(os.path.join(task_dir, 'groundtruth_workspace', 'clear_results.json'), 'w', encoding='utf-8') as f:
            json.dump(all_clear_results, f, indent=2, ensure_ascii=False)
        print("📄 Clearing results (mailbox+blog+store) saved to groundtruth_workspace/clear_results.json")

    else:
        print("❌ Test product setup failed!")
        return False

    return True


def clear_store_only():
    """Clear store only - Run clearing function independently"""
    # Read configuration from token config file
    from token_key_session import all_token_key_session

    site_url = all_token_key_session.woocommerce_site_url
    consumer_key = all_token_key_session.woocommerce_api_key
    consumer_secret = all_token_key_session.woocommerce_api_secret

    print(f"🚀 Connecting to store: {site_url}")
    print("🧹 Starting store clearing...")

    setup = TestProductSetup(site_url, consumer_key, consumer_secret)
    clear_result = setup.clear_all_products()

    # Save clearing results
    with open(os.path.join(task_dir, 'groundtruth_workspace', 'clear_results.json'), 'w', encoding='utf-8') as f:
        json.dump(clear_result, f, indent=2, ensure_ascii=False)
    print("📄 Clearing results saved to groundtruth_workspace/clear_results.json")

    if clear_result.get('success'):
        print("🎉 Store clearing complete!")
        return True
    else:
        print("⚠️ Store clearing partially complete")
        return False


def clear_blog_only():
    """Clear blog only - Run blog clearing function independently"""
    # Read configuration from token config file
    from token_key_session import all_token_key_session

    site_url = all_token_key_session.woocommerce_site_url
    consumer_key = all_token_key_session.woocommerce_api_key
    consumer_secret = all_token_key_session.woocommerce_api_secret

    print(f"🚀 Connecting to website: {site_url}")
    print("📝 Starting blog post clearing...")

    setup = TestProductSetup(site_url, consumer_key, consumer_secret)
    blog_result = setup.clear_blog_posts()

    # Save blog clearing results
    with open(os.path.join(task_dir, 'groundtruth_workspace', 'blog_clear_results.json'), 'w', encoding='utf-8') as f:
        json.dump(blog_result, f, indent=2, ensure_ascii=False)
    print("📄 Blog clearing results saved to groundtruth_workspace/blog_clear_results.json")

    if blog_result.get('success'):
        print("🎉 Blog clearing complete!")
        return True
    else:
        print("⚠️ Blog clearing partially complete")
        return False


def clear_mailbox_only():
    """Clear mailbox only - Run mailbox clearing function independently"""
    # Read configuration from token config file
    from token_key_session import all_token_key_session

    site_url = all_token_key_session.woocommerce_site_url
    consumer_key = all_token_key_session.woocommerce_api_key
    consumer_secret = all_token_key_session.woocommerce_api_secret

    print(f"🚀 Connecting to mail server...")
    print("📧 Starting mailbox clearing...")

    setup = TestProductSetup(site_url, consumer_key, consumer_secret)
    mailbox_result = setup.clear_mailbox()

    # Save mailbox clearing results
    with open(os.path.join(task_dir, 'groundtruth_workspace', 'mailbox_clear_results.json'), 'w', encoding='utf-8') as f:
        json.dump(mailbox_result, f, indent=2, ensure_ascii=False)
    print("📄 Mailbox clearing results saved to groundtruth_workspace/mailbox_clear_results.json")

    if mailbox_result.get('success'):
        print("🎉 Mailbox clearing complete!")
        return True
    else:
        print("⚠️ Mailbox clearing partially complete")
        return False


if __name__ == "__main__":
    import sys

    # Check command line arguments
    if len(sys.argv) > 1:
        if sys.argv[1] == "--clear-only":
            # Clear store only
            clear_store_only()
        elif sys.argv[1] == "--clear-mailbox-only":
            # Clear mailbox only
            clear_mailbox_only()
        elif sys.argv[1] == "--clear-blog-only":
            # Clear blog only
            clear_blog_only()
        else:
            print("Usage:")
            print("  python setup_test_products.py                     # Full process (clear mailbox+blog+store+create test products)")
            print("  python setup_test_products.py --clear-only        # Clear store only")
            print("  python setup_test_products.py --clear-mailbox-only # Clear mailbox only")
            print("  python setup_test_products.py --clear-blog-only   # Clear blog only")
    else:
        # Full process: clear mailbox + clear store + create test products
        main()
