#!/usr/bin/env python3
"""
Dynamically generate data for low-selling product filtering task
Including: product data and subscriber data
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path
from argparse import ArgumentParser
from typing import List, Dict


class ProductsDataGenerator:
    """Product and subscriber data generator"""

    def __init__(self, seed: int = 42):
        """Initialize generator"""
        random.seed(seed)
        self.current_date = datetime.now()

        # Product name library (expanded to support up to 2000 products)
        self.brands = [
            "Samsung", "LG", "Sony", "Xiaomi", "AOC", "Dell", "HP", "Lenovo", "Apple", "Asus",
            "Acer", "MSI", "Razer", "Logitech", "Microsoft", "Google", "Huawei", "OnePlus", "Oppo", "Vivo",
            "Panasonic", "Philips", "Sharp", "Toshiba", "TCL", "Hisense", "JBL", "Bose", "Sennheiser", "Corsair",
            "HyperX", "SteelSeries", "BenQ", "ViewSonic", "GIGABYTE", "EVGA", "Zotac", "Sapphire", "XFX", "Crucial"
        ]
        self.products = [
            "Monitor", "Phone", "TV", "Laptop", "Tablet", "Keyboard", "Mouse", "Headphone", "Speaker", "Camera",
            "Router", "Switch", "Hub", "Webcam", "Microphone", "Printer", "Scanner", "Projector", "SSD", "HDD",
            "RAM", "GPU", "CPU", "Motherboard", "PSU", "Cooler", "Fan", "UPS", "NAS", "Dock",
            "Stylus", "Gamepad", "Joystick", "VRHeadset", "Smartwatch", "Earbuds", "Soundbar", "Subwoofer", "Amplifier", "Mixer"
        ]
        self.accessories = [
            "Case", "Charger", "Cable", "Stand", "Cover", "Adapter", "Protector", "Holder",
            "Mount", "Sleeve", "Bag", "Pouch", "Dock", "Hub", "Splitter", "Extender",
            "Skin", "Film", "Grip", "Strap", "Clip", "Bracket", "Tray", "Mat"
        ]

        # Subscriber name library (expanded to support up to 2000 subscribers)
        self.first_names = [
            "John", "Mike", "Tom", "Sarah", "Emily", "David", "Lisa", "Kevin", "Anna", "Chris",
            "Jessica", "Daniel", "Michelle", "Brian", "Amanda", "Robert", "Jennifer", "William", "Linda", "James",
            "Mary", "Patricia", "Elizabeth", "Barbara", "Susan", "Margaret", "Dorothy", "Nancy", "Karen", "Betty",
            "Helen", "Sandra", "Donna", "Carol", "Ruth", "Sharon", "Michelle", "Laura", "Kimberly", "Deborah",
            "Michael", "Christopher", "Matthew", "Joshua", "Andrew", "Joseph", "Anthony", "Ryan", "Nicholas", "Tyler",
            "Jacob", "Ethan", "Noah", "Mason", "Lucas", "Oliver", "Elijah", "Liam", "Benjamin", "Alexander"
        ]
        self.last_names = [
            "Zhang", "Li", "Wang", "Liu", "Chen", "Yang", "Huang", "Zhao", "Wu", "Zhou",
            "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
            "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
            "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
            "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
            "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts"
        ]

    def generate_low_selling_products(self, count: int) -> List[Dict]:
        """
        Generate low-selling product data

        Args:
            count: Number of low-selling products to generate

        Returns:
            List of product data
        """
        products = []
        used_names = set()

        for i in range(count):
            # Generate unique product name
            attempts = 0
            while attempts < 100:
                # Generate product name
                if random.random() < 0.3:
                    # 30% chance to generate accessory products
                    name = f"{random.choice(self.brands)} {random.choice(self.accessories)}"
                else:
                    # 70% chance to generate main products
                    name = f"{random.choice(self.brands)} {random.choice(self.products)}"

                # Add version number or year to make name unique
                if random.random() < 0.5:
                    name += f" v{random.randint(1, 20)}"
                else:
                    name += f" {random.randint(2020, 2023)}"

                # Check if name already exists
                if name not in used_names:
                    used_names.add(name)
                    break
                attempts += 1

            # Ensure in stock for more than 90 days (90-365 days)
            days_in_stock = random.randint(91, 365)
            date_created = self.current_date - timedelta(days=days_in_stock)

            # 30-day sales < 10 (0-9)
            sales_30_days = random.randint(0, 9)
            total_sales = sales_30_days + random.randint(5, 30)

            # Price
            regular_price = round(random.uniform(19.99, 299.99), 2)
            # Apply some discount (10%-50%)
            discount = random.uniform(0.1, 0.5)
            sale_price = round(regular_price * (1 - discount), 2)

            # Stock
            stock_quantity = random.randint(10, 100)

            product = {
                "name": name,
                "type": "simple",
                "regular_price": str(regular_price),
                "sale_price": str(sale_price),
                "stock_quantity": stock_quantity,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": date_created.isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "low_selling"},
                    {"key": "sales_last_30_days", "value": str(sales_30_days)},
                    {"key": "_sales_last_30_days", "value": str(sales_30_days)},
                    {"key": "total_sales", "value": str(total_sales)},
                    {"key": "_total_sales", "value": str(total_sales)}
                ]
            }

            products.append(product)

        return products

    def generate_normal_selling_products(self, count: int) -> List[Dict]:
        """
        Generate normal-selling product data (does not meet low-selling criteria)

        Args:
            count: Number of normal-selling products to generate

        Returns:
            List of product data
        """
        products = []
        used_names = set()

        for i in range(count):
            # Generate unique product name
            attempts = 0
            while attempts < 100:
                # Generate product name
                name = f"{random.choice(self.brands)} {random.choice(self.products)}"

                # Add version number to make name unique (expanded year range to support more products)
                name += f" {random.randint(2020, 2025)}"

                # Check if name already exists
                if name not in used_names:
                    used_names.add(name)
                    break
                attempts += 1

            # Three types of normal products:
            # 1. Short time in stock (< 90 days)
            # 2. High 30-day sales (>= 10)
            # 3. Both conditions met
            product_category = random.choice(['short_time', 'high_sales', 'both'])

            if product_category == 'short_time':
                # Short time in stock
                days_in_stock = random.randint(1, 89)
                sales_30_days = random.randint(0, 15)
            elif product_category == 'high_sales':
                # High sales
                days_in_stock = random.randint(91, 300)
                sales_30_days = random.randint(10, 100)
            else:  # both
                # Both good
                days_in_stock = random.randint(1, 89)
                sales_30_days = random.randint(10, 100)

            date_created = self.current_date - timedelta(days=days_in_stock)
            total_sales = sales_30_days + random.randint(10, 100)

            # Price
            regular_price = round(random.uniform(29.99, 499.99), 2)
            # Small discount or no discount
            if random.random() < 0.5:
                sale_price = round(regular_price * random.uniform(0.9, 0.98), 2)
            else:
                sale_price = None  # No discount

            # Stock
            stock_quantity = random.randint(20, 200)

            product = {
                "name": name,
                "type": "simple",
                "regular_price": str(regular_price),
                "stock_quantity": stock_quantity,
                "manage_stock": True,
                "stock_status": "instock",
                "date_created": date_created.isoformat(),
                "meta_data": [
                    {"key": "product_type", "value": "normal_selling"},
                    {"key": "sales_last_30_days", "value": str(sales_30_days)},
                    {"key": "_sales_last_30_days", "value": str(sales_30_days)},
                    {"key": "total_sales", "value": str(total_sales)},
                    {"key": "_total_sales", "value": str(total_sales)}
                ]
            }

            if sale_price:
                product["sale_price"] = str(sale_price)

            products.append(product)

        return products

    def generate_subscribers(self, count: int) -> List[Dict]:
        """
        Generate subscriber data

        Args:
            count: Number of subscribers to generate

        Returns:
            List of subscriber data
        """
        subscribers = []
        used_emails = set()

        for i in range(count):
            # Generate unique name and email
            attempts = 0
            while attempts < 100:
                first_name = random.choice(self.first_names)
                last_name = random.choice(self.last_names)
                email = f"{first_name.lower()}{last_name.lower()}{random.randint(1, 99)}@mcpt.com"

                if email not in used_emails:
                    used_emails.add(email)
                    break
                attempts += 1

            subscriber = {
                "email": email,
                "name": f"{first_name} {last_name}"
            }

            subscribers.append(subscriber)

        return subscribers


def generate_products_and_subscribers(
    output_dir: Path,
    num_low_selling: int = 5,
    num_normal_selling: int = 3,
    num_subscribers: int = 3,
    seed: int = 42
) -> bool:
    """
    Generate product and subscriber data and save

    Args:
        output_dir: Output directory (task root directory)
        num_low_selling: Number of low-selling products
        num_normal_selling: Number of normal-selling products
        num_subscribers: Number of subscribers
        seed: Random seed

    Returns:
        True if successful
    """
    print("=" * 60)
    print("Generate product and subscriber data")
    print("=" * 60)

    try:
        # Initialize generator
        generator = ProductsDataGenerator(seed=seed)

        # Generate product data
        print(f"\n📦 Generating product data...")
        low_selling = generator.generate_low_selling_products(num_low_selling)
        normal_selling = generator.generate_normal_selling_products(num_normal_selling)

        all_products = low_selling + normal_selling
        random.shuffle(all_products)  # Shuffle order

        print(f"   ✓ Low-selling products: {num_low_selling}")
        print(f"   ✓ Normal-selling products: {num_normal_selling}")
        print(f"   ✓ Total products: {len(all_products)}")

        # Generate subscriber data
        print(f"\n👥 Generating subscriber data...")
        subscribers = generator.generate_subscribers(num_subscribers)
        print(f"   ✓ Subscribers: {num_subscribers}")

        # Save product data to preprocess directory (for WooCommerce database use)
        preprocess_dir = output_dir / "preprocess"
        preprocess_dir.mkdir(parents=True, exist_ok=True)

        products_file = preprocess_dir / "generated_products.json"
        with open(products_file, 'w', encoding='utf-8') as f:
            json.dump(all_products, f, indent=2, ensure_ascii=False)
        print(f"\n💾 Product data saved: {products_file}")

        # Save subscriber data to initial_workspace
        initial_workspace = output_dir / "initial_workspace"
        initial_workspace.mkdir(parents=True, exist_ok=True)

        subscriber_file = initial_workspace / "subscriber.json"
        subscriber_data = {"subscriber_list": subscribers}
        with open(subscriber_file, 'w', encoding='utf-8') as f:
            json.dump(subscriber_data, f, indent=2, ensure_ascii=False)
        print(f"💾 Subscriber data saved: {subscriber_file}")

        # Save groundtruth info
        groundtruth_workspace = output_dir / "groundtruth_workspace"
        groundtruth_workspace.mkdir(parents=True, exist_ok=True)

        groundtruth_file = groundtruth_workspace / "generation_metadata.json"
        metadata = {
            "generation_params": {
                "num_low_selling": num_low_selling,
                "num_normal_selling": num_normal_selling,
                "num_subscribers": num_subscribers,
                "seed": seed,
                "total_products": len(all_products)
            },
            "low_selling_products": [p["name"] for p in low_selling],
            "normal_selling_products": [p["name"] for p in normal_selling],
            "subscribers": [s["email"] for s in subscribers],
            "timestamp": datetime.now().isoformat()
        }

        with open(groundtruth_file, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
        print(f"💾 Groundtruth metadata saved: {groundtruth_file}")

        print("\n✅ Data generation complete!")
        return True

    except Exception as e:
        print(f"❌ Data generation failed: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    parser = ArgumentParser(description="Generate data for low-selling product filtering task")
    parser.add_argument("--output-dir", type=str, required=True,
                       help="Output directory (task root directory)")
    parser.add_argument("--num-low-selling", type=int, default=5,
                       help="Number of low-selling products (default: 5)")
    parser.add_argument("--num-normal-selling", type=int, default=3,
                       help="Number of normal-selling products (default: 3)")
    parser.add_argument("--num-subscribers", type=int, default=3,
                       help="Number of subscribers (default: 3)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")

    args = parser.parse_args()

    success = generate_products_and_subscribers(
        output_dir=Path(args.output_dir),
        num_low_selling=args.num_low_selling,
        num_normal_selling=args.num_normal_selling,
        num_subscribers=args.num_subscribers,
        seed=args.seed
    )

    exit(0 if success else 1)
