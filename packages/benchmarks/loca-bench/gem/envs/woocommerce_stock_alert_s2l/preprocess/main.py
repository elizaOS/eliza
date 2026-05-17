#!/usr/bin/env python3
"""
Main preprocess script for woocommerce-stock-alert task (Local Database Version).
This script orchestrates the complete initialization process:
1. Generate product data with configurable difficulty
2. Clear all email folders (INBOX, Drafts, Sent)
3. Synchronize WooCommerce products with configuration data
4. Initialize Google Sheets with stock alert data
"""

import sys
import os
import json
import random
from pathlib import Path
from argparse import ArgumentParser
from datetime import datetime

# Add current task directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
sys.path.insert(0, task_dir)



# Import nfs_safe_rmtree
current_dir = Path(__file__).parent
project_root = current_dir.parent.parent.parent.parent
sys.path.insert(0, str(project_root))
from gem.utils.filesystem import nfs_safe_rmtree

from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase
from mcp_convert.mcps.woocommerce.init_database import initialize_database as init_woocommerce_db
from mcp_convert.mcps.email.database_utils import EmailDatabase
from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase


def ensure_users_exist(db: EmailDatabase, users_info: list) -> bool:
    """Ensure users exist in the database"""
    print(f"👥 Ensuring {len(users_info)} users exist in the database...")
    
    try:
        # Read or initialize users.json
        if not db.users:
            db.users = {}
        
        for user_info in users_info:
            email = user_info['email']
            password = user_info.get('password', 'default_password')
            name = user_info.get('name', email.split('@')[0])
            
            # If user does not exist, add them
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
    """Clear email data for a specified user"""
    print(f"🗑️  Clearing email database: {user_email}...")
    
    try:
        # Get user data directory
        user_dir = db._get_user_data_dir(user_email)

        # If user data does not exist, create empty files
        if not Path(user_dir).exists():
            Path(user_dir).mkdir(parents=True, exist_ok=True)
            # Create empty emails, folders, and drafts files
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
            print(f"   ✓ Cleanup completed: {user_email}")
        
        return True
    except Exception as e:
        print(f"   ❌ Cleanup failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def generate_product_data(num_low_stock: int = 5, 
                         num_normal_stock: int = 10,
                         seed: int = 42) -> list:
    """
    Generate product data with configurable difficulty
    
    Args:
        num_low_stock: Number of products with low stock (need alert)
        num_normal_stock: Number of products with normal stock (no alert)
        seed: Random seed for reproducibility
        
    Returns:
        List of product dictionaries
    """
    random.seed(seed)
    
    # Product templates - Extended to support 100+ products
    product_templates = [
        # Electronics (40 items)
        ("Electronics", "Laptop", 800, 1500),
        ("Electronics", "Smartphone", 500, 1000),
        ("Electronics", "Tablet", 300, 600),
        ("Electronics", "Headphones", 50, 200),
        ("Electronics", "Smart Watch", 200, 400),
        ("Electronics", "Camera", 400, 1200),
        ("Electronics", "Gaming Console", 300, 500),
        ("Electronics", "Monitor", 200, 600),
        ("Electronics", "Keyboard", 50, 150),
        ("Electronics", "Mouse", 20, 80),
        ("Electronics", "Wireless Earbuds", 80, 250),
        ("Electronics", "Power Bank", 30, 80),
        ("Electronics", "USB Cable", 10, 30),
        ("Electronics", "Phone Case", 15, 40),
        ("Electronics", "Screen Protector", 10, 25),
        ("Electronics", "Wireless Charger", 25, 70),
        ("Electronics", "Bluetooth Speaker", 60, 200),
        ("Electronics", "Webcam", 50, 150),
        ("Electronics", "Microphone", 70, 250),
        ("Electronics", "External Hard Drive", 80, 200),
        ("Electronics", "SSD Drive", 100, 300),
        ("Electronics", "Router", 60, 180),
        ("Electronics", "Printer", 150, 400),
        ("Electronics", "Scanner", 100, 300),
        ("Electronics", "Projector", 300, 800),
        ("Electronics", "Smart TV", 400, 1200),
        ("Electronics", "Soundbar", 150, 400),
        ("Electronics", "VR Headset", 300, 600),
        ("Electronics", "Gaming Mouse", 40, 120),
        ("Electronics", "Gaming Keyboard", 80, 200),
        ("Electronics", "Laptop Stand", 30, 80),
        ("Electronics", "Desk Lamp", 25, 70),
        ("Electronics", "USB Hub", 20, 60),
        ("Electronics", "HDMI Cable", 15, 40),
        ("Electronics", "Monitor Arm", 50, 150),
        ("Electronics", "Docking Station", 100, 300),
        ("Electronics", "Graphics Tablet", 150, 400),
        ("Electronics", "E-Reader", 100, 250),
        ("Electronics", "Smart Home Hub", 80, 200),
        ("Electronics", "Security Camera", 60, 180),
        
        # Furniture (35 items)
        ("Furniture", "Office Chair", 100, 400),
        ("Furniture", "Desk", 150, 500),
        ("Furniture", "Bookshelf", 80, 250),
        ("Furniture", "Cabinet", 120, 400),
        ("Furniture", "Table", 100, 350),
        ("Furniture", "Sofa", 300, 1000),
        ("Furniture", "Bed Frame", 200, 600),
        ("Furniture", "Dresser", 150, 450),
        ("Furniture", "Nightstand", 60, 180),
        ("Furniture", "Coffee Table", 80, 250),
        ("Furniture", "TV Stand", 100, 300),
        ("Furniture", "Dining Table", 200, 600),
        ("Furniture", "Dining Chair", 60, 150),
        ("Furniture", "Bar Stool", 50, 120),
        ("Furniture", "Ottoman", 60, 150),
        ("Furniture", "Recliner", 250, 700),
        ("Furniture", "Loveseat", 350, 800),
        ("Furniture", "Sectional Sofa", 800, 2000),
        ("Furniture", "Wardrobe", 300, 800),
        ("Furniture", "Armoire", 250, 650),
        ("Furniture", "Console Table", 100, 300),
        ("Furniture", "Side Table", 50, 150),
        ("Furniture", "Bench", 80, 200),
        ("Furniture", "Storage Chest", 100, 250),
        ("Furniture", "Shoe Rack", 40, 100),
        ("Furniture", "Coat Rack", 30, 80),
        ("Furniture", "Mirror", 50, 200),
        ("Furniture", "Room Divider", 80, 250),
        ("Furniture", "Filing Cabinet", 100, 300),
        ("Furniture", "Laptop Desk", 60, 150),
        ("Furniture", "Standing Desk", 200, 500),
        ("Furniture", "Kids Bed", 150, 400),
        ("Furniture", "Bunk Bed", 300, 700),
        ("Furniture", "Futon", 200, 500),
        ("Furniture", "Murphy Bed", 500, 1200),
        
        # Clothing (30 items)
        ("Clothing", "T-Shirt", 10, 30),
        ("Clothing", "Jeans", 30, 80),
        ("Clothing", "Jacket", 50, 150),
        ("Clothing", "Sweater", 30, 90),
        ("Clothing", "Dress", 40, 120),
        ("Clothing", "Shoes", 40, 150),
        ("Clothing", "Sneakers", 50, 120),
        ("Clothing", "Boots", 60, 180),
        ("Clothing", "Hat", 15, 40),
        ("Clothing", "Scarf", 15, 45),
        ("Clothing", "Hoodie", 35, 80),
        ("Clothing", "Polo Shirt", 25, 60),
        ("Clothing", "Blazer", 80, 200),
        ("Clothing", "Coat", 100, 300),
        ("Clothing", "Shorts", 20, 50),
        ("Clothing", "Skirt", 25, 70),
        ("Clothing", "Leggings", 20, 50),
        ("Clothing", "Sweatpants", 25, 60),
        ("Clothing", "Formal Shirt", 30, 80),
        ("Clothing", "Tie", 15, 40),
        ("Clothing", "Belt", 15, 45),
        ("Clothing", "Socks", 10, 25),
        ("Clothing", "Gloves", 15, 40),
        ("Clothing", "Sunglasses", 20, 80),
        ("Clothing", "Watch", 50, 300),
        ("Clothing", "Backpack", 40, 120),
        ("Clothing", "Handbag", 50, 200),
        ("Clothing", "Wallet", 20, 80),
        ("Clothing", "Umbrella", 15, 40),
        ("Clothing", "Slippers", 20, 50),
        
        # Home & Garden (35 items)
        ("Home & Garden", "Vacuum Cleaner", 80, 300),
        ("Home & Garden", "Blender", 40, 120),
        ("Home & Garden", "Coffee Maker", 50, 150),
        ("Home & Garden", "Microwave", 80, 200),
        ("Home & Garden", "Air Purifier", 100, 300),
        ("Home & Garden", "Lamp", 30, 100),
        ("Home & Garden", "Plant Pot", 10, 40),
        ("Home & Garden", "Garden Tools Set", 40, 120),
        ("Home & Garden", "Watering Can", 15, 40),
        ("Home & Garden", "Outdoor Chair", 60, 180),
        ("Home & Garden", "Toaster", 30, 80),
        ("Home & Garden", "Electric Kettle", 25, 70),
        ("Home & Garden", "Rice Cooker", 40, 100),
        ("Home & Garden", "Slow Cooker", 50, 120),
        ("Home & Garden", "Air Fryer", 80, 200),
        ("Home & Garden", "Food Processor", 60, 180),
        ("Home & Garden", "Mixer", 40, 120),
        ("Home & Garden", "Dishwasher", 300, 800),
        ("Home & Garden", "Refrigerator", 500, 1500),
        ("Home & Garden", "Washing Machine", 400, 1000),
        ("Home & Garden", "Dryer", 350, 900),
        ("Home & Garden", "Iron", 25, 70),
        ("Home & Garden", "Fan", 30, 100),
        ("Home & Garden", "Heater", 50, 150),
        ("Home & Garden", "Humidifier", 40, 120),
        ("Home & Garden", "Dehumidifier", 100, 300),
        ("Home & Garden", "Curtains", 30, 80),
        ("Home & Garden", "Bedding Set", 40, 120),
        ("Home & Garden", "Pillow", 15, 50),
        ("Home & Garden", "Blanket", 25, 80),
        ("Home & Garden", "Rug", 50, 200),
        ("Home & Garden", "Wall Art", 30, 150),
        ("Home & Garden", "Clock", 20, 80),
        ("Home & Garden", "Trash Can", 15, 50),
        ("Home & Garden", "Storage Bin", 10, 40),
        
        # Sports (30 items)
        ("Sports", "Yoga Mat", 20, 60),
        ("Sports", "Dumbbell Set", 50, 150),
        ("Sports", "Treadmill", 400, 1200),
        ("Sports", "Basketball", 20, 50),
        ("Sports", "Tennis Racket", 40, 120),
        ("Sports", "Running Shoes", 60, 180),
        ("Sports", "Bicycle", 200, 800),
        ("Sports", "Helmet", 30, 80),
        ("Sports", "Swimming Goggles", 15, 40),
        ("Sports", "Fitness Tracker", 50, 150),
        ("Sports", "Exercise Bike", 250, 700),
        ("Sports", "Elliptical Machine", 400, 1000),
        ("Sports", "Rowing Machine", 300, 800),
        ("Sports", "Weight Bench", 150, 400),
        ("Sports", "Resistance Bands", 15, 40),
        ("Sports", "Jump Rope", 10, 25),
        ("Sports", "Kettlebell", 25, 80),
        ("Sports", "Medicine Ball", 30, 80),
        ("Sports", "Foam Roller", 20, 50),
        ("Sports", "Yoga Block", 10, 25),
        ("Sports", "Exercise Ball", 20, 50),
        ("Sports", "Pull-up Bar", 25, 70),
        ("Sports", "Push-up Bars", 15, 40),
        ("Sports", "Ankle Weights", 15, 40),
        ("Sports", "Workout Gloves", 15, 35),
        ("Sports", "Water Bottle", 10, 30),
        ("Sports", "Gym Bag", 25, 70),
        ("Sports", "Sports Watch", 50, 200),
        ("Sports", "Bike Lock", 20, 50),
        ("Sports", "Skateboard", 60, 180),
    ]
    
    # Supplier templates
    suppliers = [
        {"name": "TechSupply Co.", "supplier_id": "SUP001", "contact": "tech@techsupply.com"},
        {"name": "FurniturePro Ltd.", "supplier_id": "SUP002", "contact": "sales@furniturepro.com"},
        {"name": "Fashion Wholesale", "supplier_id": "SUP003", "contact": "orders@fashionwholesale.com"},
        {"name": "HomeGoods Inc.", "supplier_id": "SUP004", "contact": "contact@homegoods.com"},
        {"name": "Sports Gear Co.", "supplier_id": "SUP005", "contact": "info@sportsgear.com"},
        {"name": "Global Electronics", "supplier_id": "SUP006", "contact": "support@globalelec.com"},
        {"name": "Premium Furniture", "supplier_id": "SUP007", "contact": "sales@premiumfurn.com"},
        {"name": "Quality Apparel", "supplier_id": "SUP008", "contact": "orders@qualityapparel.com"},
    ]
    
    products = []
    total_products = num_low_stock + num_normal_stock
    
    # Select random product templates (allow duplicates if needed)
    selected_templates = random.choices(product_templates, k=total_products)
    
    # Product variant suffixes for when we have many products
    variants = ["", " Pro", " Plus", " Max", " Lite", " Mini", " Ultra", " Premium",
                " Deluxe", " Standard", " Advanced", " Basic", " Elite", " SE", " XL",
                " Pro Max", " Air", " Neo", " Flex", " Edge", " Prime", " Core", " Go",
                " Nano", " Mega", " Turbo", " Eco", " Smart", " Classic", " Modern"]

    # Additional modifiers for very large product sets (5000+)
    colors = ["", " Black", " White", " Silver", " Gold", " Blue", " Red", " Green",
              " Gray", " Navy", " Rose", " Bronze", " Platinum", " Midnight", " Space Gray"]

    sizes = ["", " Small", " Medium", " Large", " XS", " S", " M", " L", " XL", " XXL"]

    editions = ["", " 2024", " 2025", " Gen1", " Gen2", " Gen3", " V1", " V2", " V3",
                " Mark I", " Mark II", " Series A", " Series B", " Series X", " Limited"]

    for i, (category, product_name, price_min, price_max) in enumerate(selected_templates, 1):
        # Determine if this should be a low stock product
        is_low_stock = i <= num_low_stock

        # Add variant suffix if generating many products (to differentiate similar products)
        variant_suffix = ""
        color_suffix = ""
        size_suffix = ""
        edition_suffix = ""

        if total_products > 150:
            # For large product sets, add variants to make names more unique
            variant_suffix = random.choice(variants)

        if total_products > 500:
            # For very large sets, add color
            color_suffix = random.choice(colors)

        if total_products > 2000:
            # For extremely large sets, add size
            size_suffix = random.choice(sizes)

        if total_products > 4000:
            # For massive sets (5000+), add edition
            edition_suffix = random.choice(editions)
        
        # Generate product details
        sku = f"{category[:3].upper()}-{i:05d}"  # 5 digits to support 5000+ products
        name = f"{product_name}{variant_suffix}{color_suffix}{size_suffix}{edition_suffix} #{i}"
        price = round(random.uniform(price_min, price_max), 2)
        
        # Stock settings
        if is_low_stock:
            # Low stock: stock_quantity < stock_threshold (need alert)
            stock_threshold = random.randint(20, 50)
            stock_quantity = random.randint(0, stock_threshold - 1)
        else:
            # Normal stock: stock_quantity >= stock_threshold (no alert needed)
            stock_threshold = random.randint(10, 30)
            stock_quantity = random.randint(stock_threshold, stock_threshold + 100)
        
        # Select random supplier
        supplier = random.choice(suppliers)
        
        product = {
            "id": i,
            "sku": sku,
            "name": name,
            "category": category,
            "price": price,
            "stock_quantity": stock_quantity,
            "stock_threshold": stock_threshold,
            "supplier": supplier
        }
        
        products.append(product)
    
    return products


def save_product_data(products: list, output_file: Path) -> bool:
    """
    Save generated product data to JSON file
    
    Args:
        products: List of product dictionaries
        output_file: Output file path
        
    Returns:
        True if save succeeded
    """
    try:
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        data = {
            "products": products,
            "generated_at": datetime.now().isoformat(),
            "total_products": len(products),
            "low_stock_products": sum(1 for p in products if p["stock_quantity"] < p["stock_threshold"])
        }
        
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        return True
    except Exception as e:
        print(f"❌ Failed to save product data: {e}")
        return False


def clear_all_email_folders(email_db: EmailDatabase, admin_email: str) -> bool:
    """
    Clear emails from INBOX, Drafts, Sent folders using local database
    """
    print("📧 Clearing email folders...")

    try:
        # Clear admin mailbox
        if clear_email_database(email_db, admin_email):
            print("✅ All email folders cleared successfully")
            return True
        else:
            print("❌ Email cleanup failed")
            return False
    except Exception as e:
        print(f"❌ Error during email cleanup: {e}")
        import traceback
        traceback.print_exc()
        return False


class WooCommerceProductSync:
    """Handle WooCommerce product synchronization using local database"""

    def __init__(self, task_dir: Path, woocommerce_db_dir: str):
        self.task_dir = task_dir
        self.preprocess = task_dir / "preprocess"
        self.woocommerce_db_dir = woocommerce_db_dir
        
        # Initialize WooCommerce Database
        self.wc_db = WooCommerceDatabase(data_dir=woocommerce_db_dir)
        
        print("\n🎉 WooCommerce database initialized!")
        print(f"📋 Database directory: {woocommerce_db_dir}")

    def load_woocommerce_products(self):
        """Load products from woocommerce_products.json"""
        products_file = self.preprocess / "woocommerce_products.json"

        if not products_file.exists():
            raise FileNotFoundError(f"Products file not found: {products_file}")

        with open(products_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data["products"]

    def get_product_by_sku(self, sku):
        """Get product by SKU from WooCommerce database"""
        try:
            products = self.wc_db.list_products(filters={'sku': sku})
            # Return the first product that exactly matches the SKU
            for product in products:
                if product.get('sku') == sku:
                    return product
            return None
        except Exception as e:
            print(f"Error searching for product with SKU {sku}: {e}")
            return None

    def create_product(self, product_data):
        """Create a new product in WooCommerce database"""
        try:
            # Handle supplier - convert to string if it's an object
            supplier_value = product_data['supplier']
            if isinstance(supplier_value, dict):
                supplier_value = supplier_value.get('name', str(supplier_value))
            
            wc_product_data = {
                'name': product_data['name'],
                'sku': product_data['sku'],
                'stock_quantity': product_data['stock_quantity'],
                'regular_price': str(product_data['price']),
                'manage_stock': True,
                'stock_status': 'instock' if product_data['stock_quantity'] > 0 else 'outofstock',
                'status': 'publish',
                'type': 'simple',
                'description': f"{product_data['name']} - Category: {product_data['category']}",
                'meta_data': [
                    {'key': 'stock_threshold', 'value': str(product_data['stock_threshold'])},
                    {'key': 'supplier', 'value': str(supplier_value)},
                    {'key': 'category', 'value': product_data['category']}
                ]
            }
            
            # create_product returns the product dict, not just the ID
            product = self.wc_db.create_product(wc_product_data)
            if product:
                return product
            else:
                print(f"Failed to create product {product_data['name']} - create_product returned None/False")
                return None
        except Exception as e:
            print(f"Error creating product {product_data['name']}: {e}")
            import traceback
            traceback.print_exc()
            return None

    def update_product(self, product_id, updates):
        """Update existing product in WooCommerce database"""
        try:
            update_data = {}
            
            if 'stock_quantity' in updates:
                update_data['stock_quantity'] = updates['stock_quantity']
                update_data['stock_status'] = 'instock' if updates['stock_quantity'] > 0 else 'outofstock'
            
            if 'stock_threshold' in updates:
                # Get existing meta_data
                product = self.wc_db.get_product(product_id)
                meta_data = product.get('meta_data', [])
                
                # Update or add stock_threshold
                found = False
                for meta in meta_data:
                    if meta.get('key') == 'stock_threshold':
                        meta['value'] = str(updates['stock_threshold'])
                        found = True
                        break
                
                if not found:
                    meta_data.append({'key': 'stock_threshold', 'value': str(updates['stock_threshold'])})
                
                update_data['meta_data'] = meta_data
            
            # update_product returns the updated product dict
            product = self.wc_db.update_product(product_id, update_data)
            if product:
                return product
            else:
                print(f"Failed to update product {product_id}")
                return None
        except Exception as e:
            print(f"Error updating product {product_id}: {e}")
            return None

    def sync_products(self):
        """Synchronize WooCommerce products with configuration"""
        print("Starting WooCommerce product synchronization...")
        print(f"Using WooCommerce database: {self.woocommerce_db_dir}")

        target_products = self.load_woocommerce_products()
        print(f"Loaded {len(target_products)} target products from configuration")

        stats = {
            'existing_valid': 0,
            'created': 0,
            'updated': 0,
            'errors': 0
        }

        for target_product in target_products:
            sku = target_product['sku']
            product_name = target_product['name']

            try:
                existing_product = self.get_product_by_sku(sku)

                if existing_product:
                    # Check if updates needed
                    current_stock = existing_product.get('stock_quantity', 0)
                    current_threshold = None
                    
                    # Extract threshold from meta_data
                    for meta in existing_product.get('meta_data', []):
                        if meta.get('key') == 'stock_threshold':
                            try:
                                current_threshold = int(meta.get('value', 0))
                            except (ValueError, TypeError):
                                current_threshold = 0
                            break
                    
                    needs_update = (
                        current_stock != target_product['stock_quantity'] or
                        current_threshold != target_product['stock_threshold']
                    )

                    if needs_update:
                        updates = {
                            'stock_quantity': target_product['stock_quantity'],
                            'stock_threshold': target_product['stock_threshold']
                        }
                        result = self.update_product(existing_product['id'], updates)
                        if result:
                            print(f"  ✅ Updated product: {product_name}")
                            stats['updated'] += 1
                        else:
                            print(f"  ❌ Failed to update product: {product_name}")
                            stats['errors'] += 1
                    else:
                        print(f"  ✅ Product up to date: {product_name}")
                        stats['existing_valid'] += 1
                else:
                    # Create new product
                    result = self.create_product(target_product)
                    if result:
                        print(f"  ✅ Created product: {product_name}")
                        stats['created'] += 1
                    else:
                        print(f"  ❌ Failed to create product: {product_name}")
                        stats['errors'] += 1

            except Exception as e:
                print(f"  ❌ Error processing product {product_name}: {e}")
                stats['errors'] += 1

        # Show summary
        print(f"\nSynchronization Summary:")
        print(f"  Products already valid: {stats['existing_valid']}")
        print(f"  Products created: {stats['created']}")
        print(f"  Products updated: {stats['updated']}")
        print(f"  Errors: {stats['errors']}")

        # Show low stock products
        try:
            all_wc_products = self.wc_db.list_products()
            low_stock = []
            
            for product in all_wc_products:
                stock_qty = product.get('stock_quantity', 0)
                threshold = 0
                
                # Extract threshold from meta_data
                for meta in product.get('meta_data', []):
                    if meta.get('key') == 'stock_threshold':
                        try:
                            threshold = int(meta.get('value', 0))
                        except (ValueError, TypeError):
                            threshold = 0
                        break
                
                if stock_qty < threshold:
                    low_stock.append({
                        'name': product.get('name'),
                        'stock_quantity': stock_qty,
                        'stock_threshold': threshold
                    })

            if low_stock:
                print(f"\n⚠️ Low stock products detected ({len(low_stock)}):")
                for product in low_stock:
                    print(f"  - {product['name']} (Stock: {product['stock_quantity']}, Threshold: {product['stock_threshold']})")
        except Exception as e:
            print(f"Warning: Could not check low stock products: {e}")

        return stats['errors'] == 0


class GoogleSheetsInitializer:
    """Handle Google Sheets initialization using local database"""

    def __init__(self, task_dir: Path, google_sheet_db_dir: str):
        self.task_dir = task_dir
        self.google_sheet_db_dir = google_sheet_db_dir
        self.files_dir = task_dir / "files"
        self.files_dir.mkdir(exist_ok=True)
        
        # Initialize Google Sheets Database
        self.gs_db = GoogleSheetDatabase(data_dir=google_sheet_db_dir)

    def initialize_sheets(self):
        """Initialize Google Sheets using local database"""
        print("Initializing Google Sheets for stock alert task...")
        print(f"Using Google Sheets database: {self.google_sheet_db_dir}")

        # Clean up existing files
        sheet_id_file = self.files_dir / "sheet_id.txt"
        if sheet_id_file.exists():
            sheet_id_file.unlink()

        # Read template data from woocommerce_products.json
        products_file = self.task_dir / "preprocess" / "woocommerce_products.json"
        
        if not products_file.exists():
            print(f"❌ Products file not found: {products_file}")
            return False
        
        with open(products_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            products = data["products"]
        
        print(f"Loaded {len(products)} products from configuration")
        
        # Create a new spreadsheet
        spreadsheet_result = self.gs_db.create_spreadsheet("WooCommerce Stock Alert")
        spreadsheet_id = spreadsheet_result.get('spreadsheetId') if isinstance(spreadsheet_result, dict) else spreadsheet_result
        print(f"Created spreadsheet: {spreadsheet_id}")
        
        # Rename default Sheet1 to "Stock Alert"
        try:
            # Get existing sheets
            spreadsheet = self.gs_db.get_spreadsheet(spreadsheet_id)
            existing_sheets = spreadsheet.get('sheets', [])
            
            if existing_sheets:
                # Get the name of the first sheet (usually "Sheet1")
                first_sheet_name = existing_sheets[0]['properties']['title']
                # Rename it to "Stock Alert"
                if self.gs_db.rename_sheet(spreadsheet_id, first_sheet_name, "Stock Alert"):
                    print(f"   ✓ Renamed '{first_sheet_name}' to 'Stock Alert'")
                else:
                    print(f"   ℹ️  Could not rename sheet, using existing '{first_sheet_name}'")
            else:
                # Create new sheet if none exists (shouldn't happen)
                self.gs_db.create_sheet(spreadsheet_id, "Stock Alert")
                print(f"   ✓ Created 'Stock Alert' sheet")
        except Exception as e:
            print(f"   ⚠️  Warning: Could not rename sheet: {e}")
        
        # Setup Stock Alert sheet data
        # Use format matching evaluation requirements and CSV template
        # Only add header row and ONE example row as template
        stock_data = [["Product ID", "Product Name", "SKU", "Current Stock", "Safety Threshold", "Supplier Name", "Supplier ID", "Supplier Contact"]]
        
        # Add ONE example LOW-STOCK product as template (if products exist)
        if products:
            # Find the first low-stock product as example
            # (This demonstrates what kind of products should be in the sheet)
            example_product = None
            for product in products:
                if product.get('stock_quantity', 0) < product.get('stock_threshold', 0):
                    example_product = product
                    break
            
            # If no low-stock product found, use first product (shouldn't happen)
            if not example_product:
                example_product = products[0]
            
            stock_qty = example_product.get('stock_quantity', 0)
            threshold = example_product.get('stock_threshold', 0)
            
            # Extract supplier information
            supplier = example_product.get('supplier', {})
            if isinstance(supplier, dict):
                supplier_name = supplier.get('name', '')
                supplier_id = supplier.get('supplier_id', '')
                supplier_contact = supplier.get('contact', '')
            else:
                # If supplier is a string (shouldn't happen but handle it)
                supplier_name = str(supplier)
                supplier_id = ''
                supplier_contact = ''
            
            stock_data.append([
                str(example_product.get('id', '')),
                example_product.get('name', ''),
                example_product.get('sku', ''),
                str(stock_qty),
                str(threshold),
                supplier_name,
                supplier_id,
                supplier_contact
            ])
        
        # Update Stock Alert sheet with header and example data only
        num_rows = len(stock_data)
        range_notation = f"A1:H{num_rows}"  # 8 columns: A-H
        self.gs_db.update_cells(spreadsheet_id, "Stock Alert", range_notation, stock_data)
        print(f"Populated Stock Alert sheet with {len(stock_data)} rows (header + {len(stock_data)-1} low-stock example)")
        if len(stock_data) > 1:
            print(f"   ℹ️  Example product: {stock_data[1][2]} (Stock: {stock_data[1][3]}/{stock_data[1][4]})")
        print(f"   ℹ️  Agent needs to identify and add ALL other low-stock products to this sheet")
        
        # Save sheet ID
        with open(sheet_id_file, "w") as f:
            f.write(spreadsheet_id)
        print(f"Sheet ID saved: {spreadsheet_id}")
        
        print("Google Sheets initialization completed successfully!")
        return True


def main():
    """Main preprocess orchestration function"""
    parser = ArgumentParser(description="WooCommerce Stock Alert Task Preprocess (Local Database)")
    parser.add_argument("--agent_workspace", required=False, help="Agent workspace directory")
    parser.add_argument("--launch_time", required=False, help="Task launch time")
    parser.add_argument("--task_root", required=False, help="Task root directory for generated files")
    
    # Data generation control parameters
    parser.add_argument("--skip-generation", action="store_true",
                       help="Skip data generation, use existing woocommerce_products.json")
    parser.add_argument("--num-low-stock", type=int, default=10,
                       help="Number of products with low stock (need alert) (default: 5)")
    parser.add_argument("--num-normal-stock", type=int, default=100,
                       help="Number of products with normal stock (no alert) (default: 10)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    
    # Difficulty presets
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert", "extreme", "ultra", "insane",
                                "nightmare", "apocalypse", "godlike"],
                       help="Difficulty preset (optional, overrides other parameters)")
    
    args = parser.parse_args()

    # Set task directory based on task_root parameter or fallback
    if args.task_root:
        task_dir = Path(args.task_root)
    else:
        # Fallback to code directory structure (not recommended for parallel execution)
        task_dir = Path(__file__).parent.parent

    # Apply difficulty presets
    if args.difficulty:
        print(f"🎲 Using difficulty preset: {args.difficulty.upper()}")
        
        if args.difficulty == "easy":
            # Easy: Few products, low alert count
            args.num_low_stock = 3
            args.num_normal_stock = 5
        elif args.difficulty == "medium":
            # Medium: Moderate products
            args.num_low_stock = 5
            args.num_normal_stock = 10
        elif args.difficulty == "hard":
            # Hard: More products
            args.num_low_stock = 10
            args.num_normal_stock = 20
        elif args.difficulty == "expert":
            # Expert: Many products
            args.num_low_stock = 20
            args.num_normal_stock = 40
        elif args.difficulty == "extreme":
            # Extreme: Very many products
            args.num_low_stock = 50
            args.num_normal_stock = 100
        elif args.difficulty == "ultra":
            # Ultra: 100+ low-stock products
            args.num_low_stock = 100
            args.num_normal_stock = 150
        elif args.difficulty == "insane":
            # Insane: Maximum difficulty with hundreds of products
            args.num_low_stock = 150
            args.num_normal_stock = 200
        elif args.difficulty == "nightmare":
            # Nightmare: 1000+ products
            args.num_low_stock = 300
            args.num_normal_stock = 700
        elif args.difficulty == "apocalypse":
            # Apocalypse: 3000+ products
            args.num_low_stock = 800
            args.num_normal_stock = 2200
        elif args.difficulty == "godlike":
            # Godlike: 5000+ products
            args.num_low_stock = 1500
            args.num_normal_stock = 3500
    else:
        print(f"🎲 Using custom parameters")

    print("="*60)
    print("WOOCOMMERCE STOCK ALERT TASK PREPROCESS")
    print("="*60)
    print("This script will (using local databases):")
    print("0. Generate product data with configurable difficulty")
    print("1. Clear all email folders (INBOX, Drafts, Sent)")
    print("2. Synchronize WooCommerce products with configuration data")
    print("3. Initialize Google Sheets with stock alert data")
    print("="*60)
    print("Using local databases (WooCommerce + Email + Google Sheets)")
    
    if not args.skip_generation:
        print(f"\n📊 Data generation parameters:")
        print(f"   Low stock products (need alert): {args.num_low_stock}")
        print(f"   Normal stock products (no alert): {args.num_normal_stock}")
        print(f"   Total products: {args.num_low_stock + args.num_normal_stock}")
        print(f"   Random seed: {args.seed}")

    # task_dir is already set above based on task_root parameter
    
    # Admin email configuration
    admin_email = "admin@woocommerce.local"
    admin_password = "admin123"
    admin_name = "WooCommerce Admin"
    
    # Determine database directories
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        woocommerce_db_dir = str(workspace_parent / "local_db" / "woocommerce")
        email_db_dir = str(workspace_parent / "local_db" / "emails")
        google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
    else:
        woocommerce_db_dir = str(MCP_CONVERT_PATH / "mcps" / "woocommerce" / "data")
        email_db_dir = str(MCP_CONVERT_PATH / "mcps" / "email" / "data")
        google_sheet_db_dir = str(MCP_CONVERT_PATH / "mcps" / "google_sheet" / "data")
    
    print(f"\n📂 Database Directories:")
    print(f"   WooCommerce: {woocommerce_db_dir}")
    print(f"   Email: {email_db_dir}")
    print(f"   Google Sheets: {google_sheet_db_dir}")

    success_count = 0
    total_steps = 4  # Updated to include data generation step

    # Step 0: Generate product data (optional)
    if not args.skip_generation:
        print(f"\n{'='*60}")
        print("Step 0: Generate Product Data")
        print(f"{'='*60}")
        
        try:
            # Generate product data
            products = generate_product_data(
                num_low_stock=args.num_low_stock,
                num_normal_stock=args.num_normal_stock,
                seed=args.seed
            )
            
            print(f"   ✓ Generated {len(products)} products")
            print(f"   ✓ Low stock products (need alert): {sum(1 for p in products if p['stock_quantity'] < p['stock_threshold'])}")
            print(f"   ✓ Normal stock products: {sum(1 for p in products if p['stock_quantity'] >= p['stock_threshold'])}")
            
            # Save to woocommerce_products.json
            products_file = task_dir / "preprocess" / "woocommerce_products.json"
            if save_product_data(products, products_file):
                print(f"   ✓ Saved product data to: {products_file}")
                success_count += 1
            else:
                print(f"   ❌ Failed to save product data")
        except Exception as e:
            print(f"❌ Product data generation failed: {e}")
            import traceback
            traceback.print_exc()
    else:
        print(f"\n{'='*60}")
        print("Step 0: Skip Data Generation")
        print(f"{'='*60}")
        print("Using existing woocommerce_products.json")
        success_count += 1  # Still count as success since we're skipping

    # Step 1: Clean and initialize databases
    print(f"\n{'='*60}")
    print("Step 1: Clean and Initialize Databases")
    print(f"{'='*60}")
    
    try:
        # Clean WooCommerce database
        if Path(woocommerce_db_dir).exists():
            nfs_safe_rmtree(woocommerce_db_dir)
            print(f"   ✓ Removed old WooCommerce database")
        Path(woocommerce_db_dir).mkdir(parents=True, exist_ok=True)
        
        # Initialize WooCommerce database
        init_woocommerce_db(woocommerce_db_dir, verbose=False, include_demo_data=False)
        print(f"   ✓ Initialized WooCommerce database")
        
        # Clean Email database
        if Path(email_db_dir).exists():
            nfs_safe_rmtree(email_db_dir)
            print(f"   ✓ Removed old Email database")
        Path(email_db_dir).mkdir(parents=True, exist_ok=True)
        print(f"   ✓ Created Email database directory")
        
        # Clean Google Sheets database
        if Path(google_sheet_db_dir).exists():
            nfs_safe_rmtree(google_sheet_db_dir)
            print(f"   ✓ Removed old Google Sheets database")
        Path(google_sheet_db_dir).mkdir(parents=True, exist_ok=True)
        print(f"   ✓ Created Google Sheets database directory")
        
        print("✅ Databases cleaned and initialized")
    except Exception as e:
        print(f"❌ Database initialization failed: {e}")
        import traceback
        traceback.print_exc()

    # Step 2: Setup Email Database and Clear folders
    print(f"\n{'='*60}")
    print("Step 2: Setup Email Database and Clear Folders")
    print(f"{'='*60}")

    try:
        # Initialize EmailDatabase
        email_db = EmailDatabase(data_dir=email_db_dir)
        
        # Create admin user
        users_info = [
            {"email": admin_email, "password": admin_password, "name": admin_name}
        ]
        if not ensure_users_exist(email_db, users_info):
            print("❌ User creation failed")
        else:
            if clear_all_email_folders(email_db, admin_email):
                success_count += 1
                print("✅ Email folders cleared successfully")
            else:
                print("⚠️ Email folder clearing completed with warnings")
    except Exception as e:
        print(f"❌ Email setup failed: {e}")
        import traceback
        traceback.print_exc()

    # Step 3: Synchronize WooCommerce products
    print(f"\n{'='*60}")
    print("Step 3: Synchronize WooCommerce Products")
    print(f"{'='*60}")

    try:
        wc_sync = WooCommerceProductSync(task_dir, woocommerce_db_dir)
        if wc_sync.sync_products():
            success_count += 1
            print("✅ WooCommerce products synchronized successfully")
        else:
            print("❌ WooCommerce synchronization completed with errors")
    except Exception as e:
        print(f"❌ WooCommerce synchronization failed: {e}")
        import traceback
        traceback.print_exc()

    # Step 4: Initialize Google Sheets
    print(f"\n{'='*60}")
    print("Step 4: Initialize Google Sheets")
    print(f"{'='*60}")

    try:
        sheets_init = GoogleSheetsInitializer(task_dir, google_sheet_db_dir)
        if sheets_init.initialize_sheets():
            success_count += 1
            print("✅ Google Sheets initialized successfully")
        else:
            print("❌ Google Sheets initialization failed")
    except Exception as e:
        print(f"❌ Google Sheets initialization failed: {e}")
        import traceback
        traceback.print_exc()

    # Set environment variables
    os.environ['WOOCOMMERCE_DATA_DIR'] = woocommerce_db_dir
    os.environ['EMAIL_DATA_DIR'] = email_db_dir
    os.environ['GOOGLE_SHEET_DATA_DIR'] = google_sheet_db_dir
    
    # Write environment variable file
    if args.agent_workspace:
        env_file = Path(args.agent_workspace).parent / "local_db" / ".env"
    else:
        env_file = Path(woocommerce_db_dir).parent / ".env"
    
    try:
        env_file.parent.mkdir(parents=True, exist_ok=True)
        with open(env_file, 'w') as f:
            f.write(f"# WooCommerce Stock Alert Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export WOOCOMMERCE_DATA_DIR={woocommerce_db_dir}\n")
            f.write(f"export EMAIL_DATA_DIR={email_db_dir}\n")
            f.write(f"export GOOGLE_SHEET_DATA_DIR={google_sheet_db_dir}\n")
        print(f"\n📄 Environment variable file created: {env_file}")
    except Exception as e:
        print(f"⚠️ Unable to create environment variable file: {e}")

    # Final summary
    print(f"\n{'='*60}")
    print("PREPROCESS SUMMARY")
    print(f"{'='*60}")
    print(f"Completed steps: {success_count}/{total_steps}")

    if success_count == total_steps:
        print("✅ All preprocessing steps completed successfully!")
        print("\nInitialized components:")
        if not args.skip_generation:
            print(f"  - Product data generated ({args.num_low_stock + args.num_normal_stock} products)")
        print("  - Email database initialized and folders cleared")
        print("  - WooCommerce products synchronized with configuration")
        print("  - Google Sheets initialized with stock alert data")
        print(f"\n📂 Database Locations:")
        print(f"   WooCommerce: {woocommerce_db_dir}")
        print(f"   Email: {email_db_dir}")
        print(f"   Google Sheets: {google_sheet_db_dir}")
        print(f"\n👤 Admin Account:")
        print(f"   Email: {admin_email}")
        print(f"   Password: {admin_password}")
        
        if not args.skip_generation:
            print(f"\n📊 Generated Data Statistics:")
            print(f"   Total products: {args.num_low_stock + args.num_normal_stock}")
            print(f"   Low stock products (need alert): {args.num_low_stock}")
            print(f"   Normal stock products (no alert): {args.num_normal_stock}")
            if args.difficulty:
                print(f"   Difficulty: {args.difficulty.upper()}")

        return True
    else:
        print("❌ Some preprocessing steps failed!")
        print("Please check the error messages above and retry.")
        return False


if __name__ == "__main__":
    result = main()
    sys.exit(0 if result else 1)