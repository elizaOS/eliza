#!/usr/bin/env python3
"""
Generic WooCommerce Order Data Generation Utilities

This module provides generic functions for generating test order data
that can be used across multiple WooCommerce-related tasks.
"""

import random
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass


@dataclass
class CustomerData:
    """Customer data structure"""
    name: str
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None

    def __post_init__(self):
        if not self.first_name or not self.last_name:
            name_parts = self.name.split()
            self.first_name = name_parts[0] if name_parts else self.name
            self.last_name = name_parts[-1] if len(name_parts) > 1 else ""


@dataclass
class ProductData:
    """Product data structure"""
    name: str
    price: float
    product_id: Optional[int] = None


@dataclass
class OrderGenerationConfig:
    """Configuration for order generation"""
    order_count: int = 20
    completed_percentage: float = 0.7  # 70% completed orders
    date_range_days: int = 7  # Orders from last 7 days
    min_quantity: int = 1
    max_quantity: int = 3
    order_id_start: int = 100
    shuffle_orders: bool = True
    time_seed: Optional[int] = None  # If None, uses current time


class OrderDataGenerator:
    """Generic order data generator for WooCommerce testing"""

    # Default customer dataset (expanded to 200 customers)
    DEFAULT_CUSTOMERS = [
        # Original 21 customers
        CustomerData("Nancy Hill", "nancy.hill@mcp.com"),
        CustomerData("Cynthia Mendoza", "cynthia.mendoza@mcp.com"),
        CustomerData("Eric Jackson", "ejackson@mcp.com"),
        CustomerData("Amanda Evans", "aevans@mcp.com"),
        CustomerData("Kathleen Jones", "kathleen.jones@mcp.com"),
        CustomerData("Henry Howard", "henry_howard51@mcp.com"),
        CustomerData("Frances Miller", "frances.miller@mcp.com"),
        CustomerData("Jessica Patel", "jessicap@mcp.com"),
        CustomerData("Ryan Myers", "rmyers81@mcp.com"),
        CustomerData("Zachary Baker", "zachary.baker53@mcp.com"),
        CustomerData("Pamela Brooks", "pbrooks@mcp.com"),
        CustomerData("Eric Torres", "etorres4@mcp.com"),
        CustomerData("Tyler Perez", "tyler_perez28@mcp.com"),
        CustomerData("Janet Brown", "brownj@mcp.com"),
        CustomerData("Amanda Wilson", "wilsona@mcp.com"),
        CustomerData("Dorothy Adams", "dorothya69@mcp.com"),
        CustomerData("Aaron Clark", "aaron.clark@mcp.com"),
        CustomerData("Deborah Rodriguez", "drodriguez@mcp.com"),
        CustomerData("David Lopez", "davidl35@mcp.com"),
        CustomerData("Karen White", "karen.white66@mcp.com"),
        CustomerData("Alexander Williams", "alexander_williams@mcp.com"),
        # Extended customers (179 more, total 200)
        CustomerData("Michael Chen", "michael.chen@mcp.com"),
        CustomerData("Sarah Johnson", "sarah.johnson@mcp.com"),
        CustomerData("James Martinez", "jmartinez@mcp.com"),
        CustomerData("Emily Davis", "emily.davis@mcp.com"),
        CustomerData("Robert Garcia", "rgarcia22@mcp.com"),
        CustomerData("Jennifer Lee", "jennifer.lee@mcp.com"),
        CustomerData("William Thompson", "wthompson@mcp.com"),
        CustomerData("Linda Anderson", "linda.anderson@mcp.com"),
        CustomerData("Christopher Moore", "cmoore45@mcp.com"),
        CustomerData("Patricia Taylor", "patricia.taylor@mcp.com"),
        CustomerData("Daniel Jackson", "djackson@mcp.com"),
        CustomerData("Elizabeth Martin", "emartin@mcp.com"),
        CustomerData("Matthew Harris", "matthew.harris@mcp.com"),
        CustomerData("Barbara Clark", "bclark77@mcp.com"),
        CustomerData("Anthony Lewis", "anthony.lewis@mcp.com"),
        CustomerData("Susan Walker", "swalker@mcp.com"),
        CustomerData("Mark Robinson", "mark.robinson@mcp.com"),
        CustomerData("Margaret Hall", "mhall@mcp.com"),
        CustomerData("Steven Young", "steven.young@mcp.com"),
        CustomerData("Lisa King", "lisa.king@mcp.com"),
        CustomerData("Paul Wright", "pwright33@mcp.com"),
        CustomerData("Betty Scott", "betty.scott@mcp.com"),
        CustomerData("Andrew Green", "agreen@mcp.com"),
        CustomerData("Sandra Adams", "sandra.adams@mcp.com"),
        CustomerData("Joshua Baker", "joshua.baker@mcp.com"),
        CustomerData("Donna Nelson", "dnelson@mcp.com"),
        CustomerData("Kevin Carter", "kevin.carter@mcp.com"),
        CustomerData("Carol Mitchell", "carol.mitchell@mcp.com"),
        CustomerData("Brian Perez", "bperez88@mcp.com"),
        CustomerData("Michelle Roberts", "mroberts@mcp.com"),
        CustomerData("Edward Turner", "edward.turner@mcp.com"),
        CustomerData("Amanda Phillips", "aphillips@mcp.com"),
        CustomerData("Ronald Campbell", "rcampbell@mcp.com"),
        CustomerData("Kimberly Parker", "kimberly.parker@mcp.com"),
        CustomerData("Timothy Evans", "tevans@mcp.com"),
        CustomerData("Debra Collins", "debra.collins@mcp.com"),
        CustomerData("Jason Edwards", "jason.edwards@mcp.com"),
        CustomerData("Stephanie Stewart", "sstewart@mcp.com"),
        CustomerData("Jeffrey Morris", "jmorris56@mcp.com"),
        CustomerData("Rebecca Rogers", "rebecca.rogers@mcp.com"),
        CustomerData("Gary Reed", "gary.reed@mcp.com"),
        CustomerData("Sharon Cook", "scook@mcp.com"),
        CustomerData("Ryan Morgan", "ryan.morgan@mcp.com"),
        CustomerData("Cynthia Bell", "cbell@mcp.com"),
        CustomerData("Jacob Murphy", "jacob.murphy@mcp.com"),
        CustomerData("Kathleen Bailey", "kbailey@mcp.com"),
        CustomerData("Nicholas Rivera", "nrivera@mcp.com"),
        CustomerData("Amy Cooper", "amy.cooper@mcp.com"),
        CustomerData("Stephen Richardson", "srichardson@mcp.com"),
        CustomerData("Angela Cox", "angela.cox@mcp.com"),
        CustomerData("Jonathan Howard", "jhoward@mcp.com"),
        CustomerData("Brenda Ward", "bward@mcp.com"),
        CustomerData("Justin Torres", "justin.torres@mcp.com"),
        CustomerData("Anna Peterson", "apeterson@mcp.com"),
        CustomerData("Brandon Gray", "brandon.gray@mcp.com"),
        CustomerData("Katherine Ramirez", "kramirez@mcp.com"),
        CustomerData("Samuel James", "sjames@mcp.com"),
        CustomerData("Nicole Watson", "nicole.watson@mcp.com"),
        CustomerData("Gregory Brooks", "gbrooks@mcp.com"),
        CustomerData("Christine Kelly", "ckelly@mcp.com"),
        CustomerData("Frank Sanders", "frank.sanders@mcp.com"),
        CustomerData("Rachel Price", "rprice@mcp.com"),
        CustomerData("Patrick Bennett", "patrick.bennett@mcp.com"),
        CustomerData("Janet Wood", "jwood@mcp.com"),
        CustomerData("Jack Barnes", "jack.barnes@mcp.com"),
        CustomerData("Maria Ross", "mross@mcp.com"),
        CustomerData("Dennis Henderson", "dhenderson@mcp.com"),
        CustomerData("Catherine Coleman", "catherine.coleman@mcp.com"),
        CustomerData("Jerry Jenkins", "jjenkins@mcp.com"),
        CustomerData("Diane Perry", "dperry@mcp.com"),
        CustomerData("Tyler Powell", "tyler.powell@mcp.com"),
        CustomerData("Julie Long", "jlong@mcp.com"),
        CustomerData("Aaron Patterson", "apatterson@mcp.com"),
        CustomerData("Heather Hughes", "heather.hughes@mcp.com"),
        CustomerData("Henry Flores", "hflores@mcp.com"),
        CustomerData("Gloria Washington", "gwashington@mcp.com"),
        CustomerData("Douglas Butler", "douglas.butler@mcp.com"),
        CustomerData("Teresa Simmons", "tsimmons@mcp.com"),
        CustomerData("Adam Foster", "adam.foster@mcp.com"),
        CustomerData("Ann Gonzales", "agonzales@mcp.com"),
        CustomerData("Nathan Bryant", "nathan.bryant@mcp.com"),
        CustomerData("Jean Alexander", "jalexander@mcp.com"),
        CustomerData("Zachary Russell", "zrussell@mcp.com"),
        CustomerData("Alice Griffin", "alice.griffin@mcp.com"),
        CustomerData("Carl Diaz", "cdiaz@mcp.com"),
        CustomerData("Julia Hayes", "jhayes@mcp.com"),
        CustomerData("Kyle Myers", "kyle.myers@mcp.com"),
        CustomerData("Marie Ford", "mford@mcp.com"),
        CustomerData("Eugene Hamilton", "ehamilton@mcp.com"),
        CustomerData("Frances Graham", "frances.graham@mcp.com"),
        CustomerData("Lawrence Sullivan", "lsullivan@mcp.com"),
        CustomerData("Joyce Wallace", "jwallace@mcp.com"),
        CustomerData("Peter West", "peter.west@mcp.com"),
        CustomerData("Judy Cole", "jcole@mcp.com"),
        CustomerData("Billy Gibson", "bgibson@mcp.com"),
        CustomerData("Megan McDonald", "megan.mcdonald@mcp.com"),
        CustomerData("Bruce Cruz", "bcruz@mcp.com"),
        CustomerData("Janice Marshall", "jmarshall@mcp.com"),
        CustomerData("Ralph Owens", "ralph.owens@mcp.com"),
        CustomerData("Evelyn George", "egeorge@mcp.com"),
        CustomerData("Roy Burns", "rburns@mcp.com"),
        CustomerData("Christina Stone", "christina.stone@mcp.com"),
        CustomerData("Louis Gordon", "lgordon@mcp.com"),
        CustomerData("Beverly Ortiz", "bortiz@mcp.com"),
        CustomerData("Russell Mendez", "russell.mendez@mcp.com"),
        CustomerData("Cheryl Silva", "csilva@mcp.com"),
        CustomerData("Philip Shaw", "pshaw@mcp.com"),
        CustomerData("Theresa Hunt", "theresa.hunt@mcp.com"),
        CustomerData("Johnny Daniels", "jdaniels@mcp.com"),
        CustomerData("Denise Palmer", "dpalmer@mcp.com"),
        CustomerData("Craig Mills", "craig.mills@mcp.com"),
        CustomerData("Carolyn Nguyen", "cnguyen@mcp.com"),
        CustomerData("Terry Reyes", "treyes@mcp.com"),
        CustomerData("Janet Cruz", "janet.cruz@mcp.com"),
        CustomerData("Sean Ellis", "sellis@mcp.com"),
        CustomerData("Martha Knight", "mknight@mcp.com"),
        CustomerData("Austin Fox", "austin.fox@mcp.com"),
        CustomerData("Sara Cunningham", "scunningham@mcp.com"),
        CustomerData("Jesse Gordon", "jgordon@mcp.com"),
        CustomerData("Kathryn Webb", "kathryn.webb@mcp.com"),
        CustomerData("Christian Simpson", "csimpson@mcp.com"),
        CustomerData("Jacqueline Stevens", "jstevens@mcp.com"),
        CustomerData("Shawn Crawford", "shawn.crawford@mcp.com"),
        CustomerData("Lillian Olson", "lolson@mcp.com"),
        CustomerData("Dylan Boyd", "dboyd@mcp.com"),
        CustomerData("Marilyn Mason", "marilyn.mason@mcp.com"),
        CustomerData("Bryan Garza", "bgarza@mcp.com"),
        CustomerData("Joan Warren", "jwarren@mcp.com"),
        CustomerData("Albert Dixon", "albert.dixon@mcp.com"),
        CustomerData("Ashley Ramos", "aramos@mcp.com"),
        CustomerData("Joe Harvey", "jharvey@mcp.com"),
        CustomerData("Kelly Watkins", "kelly.watkins@mcp.com"),
        CustomerData("Willie Spencer", "wspencer@mcp.com"),
        CustomerData("Tammy Weaver", "tweaver@mcp.com"),
        CustomerData("Gabriel Holmes", "gabriel.holmes@mcp.com"),
        CustomerData("Bonnie Fuller", "bfuller@mcp.com"),
        CustomerData("Vincent Hudson", "vhudson@mcp.com"),
        CustomerData("Irene Snyder", "irene.snyder@mcp.com"),
        CustomerData("Harold Lane", "hlane@mcp.com"),
        CustomerData("Tiffany Chapman", "tchapman@mcp.com"),
        CustomerData("Randy Stone", "randy.stone@mcp.com"),
        CustomerData("Lori Knight", "lknight@mcp.com"),
        CustomerData("Howard Hicks", "hhicks@mcp.com"),
        CustomerData("Melissa Freeman", "melissa.freeman@mcp.com"),
        CustomerData("Carlos Day", "cday@mcp.com"),
        CustomerData("Norma Wade", "nwade@mcp.com"),
        CustomerData("Victor Holland", "victor.holland@mcp.com"),
        CustomerData("Wanda Burke", "wburke@mcp.com"),
        CustomerData("Martin Walters", "mwalters@mcp.com"),
        CustomerData("Ruby Bishop", "ruby.bishop@mcp.com"),
        CustomerData("Phillip Lawrence", "plawrence@mcp.com"),
        CustomerData("Judith Fields", "jfields@mcp.com"),
        CustomerData("Ernest Welch", "ernest.welch@mcp.com"),
        CustomerData("Rose Park", "rpark@mcp.com"),
        CustomerData("Todd Harper", "tharper@mcp.com"),
        CustomerData("Anne Grant", "anne.grant@mcp.com"),
        CustomerData("Stanley Ferguson", "sferguson@mcp.com"),
        CustomerData("Diana Ray", "dray@mcp.com"),
        CustomerData("Raymond Carlson", "raymond.carlson@mcp.com"),
        CustomerData("Marie Jensen", "mjensen@mcp.com"),
        CustomerData("Bobby Carroll", "bcarroll@mcp.com"),
        CustomerData("Paula Williamson", "paula.williamson@mcp.com"),
        CustomerData("Leonard Howell", "lhowell@mcp.com"),
        CustomerData("Phyllis Dean", "pdean@mcp.com"),
        CustomerData("Wayne Medina", "wayne.medina@mcp.com"),
        CustomerData("Lucille Carr", "lcarr@mcp.com"),
        CustomerData("Clarence Stanley", "cstanley@mcp.com"),
        CustomerData("Emily Fowler", "emily.fowler@mcp.com"),
    ]

    # Default product dataset
    DEFAULT_PRODUCTS = [
        ProductData("Wireless Bluetooth Earphones", 299.00),
        ProductData("Smart Watch", 899.00),
        ProductData("Portable Power Bank", 129.00),
        ProductData("Wireless Charger", 89.00),
        ProductData("Phone Stand", 39.00),
        ProductData("Cable Set", 49.00),
        ProductData("Bluetooth Speaker", 199.00),
        ProductData("Car Charger", 59.00),
        ProductData("Phone Case", 29.00),
        ProductData("Screen Protector", 19.00),
    ]

    def __init__(self, customers: List[CustomerData] = None, products: List[ProductData] = None):
        """
        Initialize the order generator

        Args:
            customers: List of customer data. If None, uses default customers
            products: List of product data. If None, uses default products
        """
        self.customers = customers or self.DEFAULT_CUSTOMERS.copy()
        self.products = products or self.DEFAULT_PRODUCTS.copy()

    def generate_orders(self, config: OrderGenerationConfig) -> List[Dict]:
        """
        Generate order data based on configuration

        Args:
            config: Order generation configuration

        Returns:
            List of order dictionaries
        """
        print("📦 Generating order data...")

        # Set random seed
        seed = config.time_seed if config.time_seed is not None else int(time.time())
        random.seed(seed)
        print(f"  🎲 Using random seed: {seed}")

        orders = []
        now = datetime.now()
        completed_count = int(config.order_count * config.completed_percentage)

        print(f"  Creating {config.order_count} orders ({completed_count} completed, {config.order_count - completed_count} processing)...")

        for i in range(config.order_count):
            # Select customer (cycle through if more orders than customers)
            customer = self.customers[i % len(self.customers)]
            product = random.choice(self.products)

            # Random order date within the specified range
            order_days_ago = random.randint(1, config.date_range_days)
            order_date = now - timedelta(days=order_days_ago)

            # Determine order status based on completion percentage
            if i < completed_count:
                status = "completed"
                # Completion date is 2-5 days after order date
                date_completed = order_date + timedelta(days=random.randint(2, 5))
                # Ensure completion date is not in the future
                if date_completed > now:
                    date_completed = now - timedelta(days=random.randint(0, 2))
            else:
                status = random.choice(["processing", "on-hold"])
                date_completed = None

            order = {
                "order_id": config.order_id_start + i,
                "order_number": f"{config.order_id_start + i}",
                "customer_email": customer.email,
                "customer_name": customer.name,
                "status": status,
                "date_created": order_date.strftime('%Y-%m-%dT%H:%M:%S'),
                "date_completed": date_completed.strftime('%Y-%m-%dT%H:%M:%S') if date_completed else None,
                "product_name": product.name,
                "product_price": product.price,
                "quantity": random.randint(config.min_quantity, config.max_quantity),
                "period": f"recent_{config.date_range_days}_days"
            }
            orders.append(order)

        # Shuffle orders if requested
        if config.shuffle_orders:
            print("  🔀 Shuffling order sequence...")
            random.shuffle(orders)

        return orders

    def generate_historical_orders(self,
                                 count: int = 10,
                                 days_ago_start: int = 8,
                                 days_ago_end: int = 30,
                                 order_id_start: int = 200,
                                 status: str = "completed") -> List[Dict]:
        """
        Generate historical orders (older than recent period)

        Args:
            count: Number of historical orders to generate
            days_ago_start: Start of historical period (days ago)
            days_ago_end: End of historical period (days ago)
            order_id_start: Starting order ID for historical orders
            status: Order status for historical orders

        Returns:
            List of historical order dictionaries
        """
        print(f"📜 Generating {count} historical orders ({days_ago_start}-{days_ago_end} days ago)...")

        orders = []
        now = datetime.now()

        for i in range(count):
            customer = self.customers[i % len(self.customers)]
            product = random.choice(self.products)

            # Random date in the historical period
            order_days_ago = random.randint(days_ago_start, days_ago_end)
            order_date = now - timedelta(days=order_days_ago)

            if status == "completed":
                date_completed = order_date + timedelta(days=random.randint(3, 7))
            else:
                date_completed = None

            order = {
                "order_id": order_id_start + i,
                "order_number": f"{order_id_start + i}",
                "customer_email": customer.email,
                "customer_name": customer.name,
                "status": status,
                "date_created": order_date.strftime('%Y-%m-%dT%H:%M:%S'),
                "date_completed": date_completed.strftime('%Y-%m-%dT%H:%M:%S') if date_completed else None,
                "product_name": product.name,
                "product_price": product.price,
                "quantity": random.randint(1, 3),
                "period": f"historical_{days_ago_start}_{days_ago_end}_days"
            }
            orders.append(order)

        return orders

    def create_woocommerce_order_data(self, order: Dict, virtual_product_id: int = 1) -> Dict:
        """
        Convert order data to WooCommerce API format

        Args:
            order: Order data dictionary
            virtual_product_id: Product ID to use for all orders

        Returns:
            WooCommerce API formatted order data
        """
        item_total = float(order["product_price"]) * order["quantity"]

        return {
            "status": order["status"],
            "customer_id": 1,  # Default customer ID
            "payment_method": "bacs",
            "payment_method_title": "Direct Bank Transfer",
            "total": str(item_total),
            "billing": {
                "first_name": order["customer_name"].split()[0] if " " in order["customer_name"] else order["customer_name"],
                "last_name": order["customer_name"].split()[-1] if " " in order["customer_name"] else "",
                "email": order["customer_email"]
            },
            "line_items": [
                {
                    "product_id": virtual_product_id,
                    "name": order["product_name"],
                    "quantity": order["quantity"],
                    "price": str(order["product_price"]),
                    "total": str(item_total),
                    "subtotal": str(item_total)
                }
            ],
            "meta_data": [
                {"key": "test_order", "value": "true"},
                {"key": "original_order_id", "value": str(order["order_id"])},
                {"key": "original_date_created", "value": order["date_created"]},
                {"key": "original_date_completed", "value": order["date_completed"] or ""},
                {"key": "period", "value": order["period"]},
                {"key": "generated_by", "value": "order_generator"}
            ]
        }

    @staticmethod
    def filter_orders_by_status(orders: List[Dict], status: str) -> List[Dict]:
        """
        Filter orders by status

        Args:
            orders: List of order dictionaries
            status: Status to filter by

        Returns:
            Filtered list of orders
        """
        return [order for order in orders if order.get("status") == status]

    @staticmethod
    def get_order_statistics(orders: List[Dict]) -> Dict[str, Any]:
        """
        Get statistics about generated orders

        Args:
            orders: List of order dictionaries

        Returns:
            Dictionary with order statistics
        """
        status_counts = {}
        total_value = 0
        customer_emails = set()

        for order in orders:
            # Count statuses
            status = order.get("status", "unknown")
            status_counts[status] = status_counts.get(status, 0) + 1

            # Calculate total value
            item_total = float(order.get("product_price", 0)) * order.get("quantity", 1)
            total_value += item_total

            # Count unique customers
            customer_emails.add(order.get("customer_email", ""))

        return {
            "total_orders": len(orders),
            "status_counts": status_counts,
            "total_value": total_value,
            "unique_customers": len(customer_emails),
            "customer_emails": list(customer_emails)
        }


# Convenience functions for common use cases
def create_customer_survey_orders(seed: Optional[int] = None) -> Tuple[List[Dict], List[Dict]]:
    """
    Create orders specifically for customer survey tasks

    Returns:
        Tuple of (all_orders, completed_orders_only)
    """
    generator = OrderDataGenerator()
    config = OrderGenerationConfig(
        order_count=20,
        completed_percentage=0.7,
        date_range_days=7,
        time_seed=seed
    )

    all_orders = generator.generate_orders(config)
    completed_orders = generator.filter_orders_by_status(all_orders, "completed")

    return all_orders, completed_orders


def create_product_analysis_orders(seed: Optional[int] = None) -> List[Dict]:
    """
    Create orders for product analysis tasks (mix of recent and historical)

    Returns:
        List of all generated orders
    """
    generator = OrderDataGenerator()

    # Recent orders
    recent_config = OrderGenerationConfig(
        order_count=15,
        completed_percentage=0.6,
        date_range_days=30,
        time_seed=seed
    )
    recent_orders = generator.generate_orders(recent_config)

    # Historical orders
    historical_orders = generator.generate_historical_orders(
        count=25,
        days_ago_start=31,
        days_ago_end=120,
        order_id_start=200
    )

    all_orders = recent_orders + historical_orders
    if recent_config.shuffle_orders:
        random.shuffle(all_orders)

    return all_orders


def create_new_welcome_orders(
    seed: Optional[int] = None,
    total_orders: int = 30,
    first_time_customer_count: int = 12,
    noise_orders_outside_window: int = 0,
    noise_orders_incomplete: int = 0,
    date_range_days: int = 7
) -> Tuple[List[Dict], List[Dict]]:
    """
    Create orders specifically for new welcome email tasks
    
    This generates a mix of customers with multiple orders and first-time customers.
    First-time customers are those who have only one completed order.
    
    Args:
        seed: Random seed for reproducibility
        total_orders: Total number of orders to generate
        first_time_customer_count: Target number of first-time customers (customers with only 1 order)
        noise_orders_outside_window: Number of noise orders that fall outside the 7-day window
        noise_orders_incomplete: Number of incomplete orders (processing/on-hold status)
        date_range_days: Date range for valid orders (default 7 days)
    
    Returns:
        Tuple of (all_orders, first_time_customer_orders)
        - all_orders: All generated orders (including noise)
        - first_time_customer_orders: Orders from customers who have only one completed order in the valid window
    """
    generator = OrderDataGenerator()
    
    # Set random seed
    if seed is not None:
        random.seed(seed)
    
    # Calculate how many orders should go to first-time vs repeat customers
    # First-time customers get 1 order each
    # Remaining orders go to repeat customers
    repeat_customer_orders = total_orders - first_time_customer_count
    
    if repeat_customer_orders < 0:
        print(f"⚠️  Warning: first_time_customer_count ({first_time_customer_count}) > total_orders ({total_orders})")
        print(f"   Adjusting to generate {total_orders} first-time customer orders only")
        first_time_customer_count = total_orders
        repeat_customer_orders = 0
    
    # Assign customers for first-time orders (one order per customer)
    available_customers = generator.customers.copy()
    random.shuffle(available_customers)
    
    first_time_customers = available_customers[:first_time_customer_count]
    repeat_customers = available_customers[first_time_customer_count:first_time_customer_count + max(1, repeat_customer_orders // 2)]
    
    if not repeat_customers and repeat_customer_orders > 0:
        # Use some first-time customers as repeat if not enough customers
        repeat_customers = available_customers[first_time_customer_count//2:first_time_customer_count//2 + 1]
    
    # Generate first-time customer orders (within date range, completed)
    config_first_time = OrderGenerationConfig(
        order_count=first_time_customer_count,
        completed_percentage=1.0,  # All completed
        date_range_days=date_range_days,
        time_seed=seed
    )
    
    orders = []
    now = datetime.now()
    order_id = 100
    
    # Generate first-time customer orders
    for i, customer in enumerate(first_time_customers):
        product = random.choice(generator.products)
        order_days_ago = random.randint(1, date_range_days)
        order_date = now - timedelta(days=order_days_ago)
        date_completed = order_date + timedelta(days=random.randint(1, 3))
        if date_completed > now:
            date_completed = now
        
        order = {
            "order_id": order_id,
            "order_number": f"{order_id}",
            "customer_email": customer.email,
            "customer_name": customer.name,
            "status": "completed",
            "date_created": order_date.strftime('%Y-%m-%dT%H:%M:%S'),
            "date_completed": date_completed.strftime('%Y-%m-%dT%H:%M:%S'),
            "product_name": product.name,
            "product_price": product.price,
            "quantity": random.randint(1, 3),
            "period": f"recent_{date_range_days}_days"
        }
        orders.append(order)
        order_id += 1
    
    # Generate repeat customer orders (within date range, completed)
    for i in range(repeat_customer_orders):
        customer = random.choice(repeat_customers)
        product = random.choice(generator.products)
        order_days_ago = random.randint(1, date_range_days)
        order_date = now - timedelta(days=order_days_ago)
        date_completed = order_date + timedelta(days=random.randint(1, 3))
        if date_completed > now:
            date_completed = now
        
        order = {
            "order_id": order_id,
            "order_number": f"{order_id}",
            "customer_email": customer.email,
            "customer_name": customer.name,
            "status": "completed",
            "date_created": order_date.strftime('%Y-%m-%dT%H:%M:%S'),
            "date_completed": date_completed.strftime('%Y-%m-%dT%H:%M:%S'),
            "product_name": product.name,
            "product_price": product.price,
            "quantity": random.randint(1, 3),
            "period": f"recent_{date_range_days}_days"
        }
        orders.append(order)
        order_id += 1
    
    # Add noise orders outside the date window (8+ days ago)
    for i in range(noise_orders_outside_window):
        customer = random.choice(available_customers)
        product = random.choice(generator.products)
        order_days_ago = random.randint(date_range_days + 1, date_range_days + 30)  # 8-37 days ago
        order_date = now - timedelta(days=order_days_ago)
        date_completed = order_date + timedelta(days=random.randint(1, 3))
        
        order = {
            "order_id": order_id,
            "order_number": f"{order_id}",
            "customer_email": customer.email,
            "customer_name": customer.name,
            "status": "completed",
            "date_created": order_date.strftime('%Y-%m-%dT%H:%M:%S'),
            "date_completed": date_completed.strftime('%Y-%m-%dT%H:%M:%S'),
            "product_name": product.name,
            "product_price": product.price,
            "quantity": random.randint(1, 3),
            "period": f"noise_outside_window"
        }
        orders.append(order)
        order_id += 1
    
    # Add noise incomplete orders (within date range but not completed)
    for i in range(noise_orders_incomplete):
        customer = random.choice(available_customers)
        product = random.choice(generator.products)
        order_days_ago = random.randint(1, date_range_days)
        order_date = now - timedelta(days=order_days_ago)
        status = random.choice(["processing", "on-hold", "pending"])
        
        order = {
            "order_id": order_id,
            "order_number": f"{order_id}",
            "customer_email": customer.email,
            "customer_name": customer.name,
            "status": status,
            "date_created": order_date.strftime('%Y-%m-%dT%H:%M:%S'),
            "date_completed": None,
            "product_name": product.name,
            "product_price": product.price,
            "quantity": random.randint(1, 3),
            "period": f"noise_incomplete"
        }
        orders.append(order)
        order_id += 1
    
    # Shuffle all orders
    random.shuffle(orders)
    
    # Identify true first-time customers (only counting valid completed orders in date range)
    customer_valid_order_count = {}
    for order in orders:
        email = order.get('customer_email', '')
        # Only count completed orders within the date range
        if (email and 
            order.get('status') == 'completed' and 
            order.get('period') == f'recent_{date_range_days}_days'):
            customer_valid_order_count[email] = customer_valid_order_count.get(email, 0) + 1
    
    # Filter for first-time customers (only 1 valid completed order)
    first_time_orders = []
    for order in orders:
        email = order.get('customer_email', '')
        if (email and 
            customer_valid_order_count.get(email, 0) == 1 and
            order.get('status') == 'completed' and
            order.get('period') == f'recent_{date_range_days}_days'):
            first_time_orders.append(order)
    
    total_generated = len(orders)
    valid_orders = len([o for o in orders if o.get('period') == f'recent_{date_range_days}_days' and o.get('status') == 'completed'])
    
    print(f"📊 Generated {total_generated} total orders:")
    print(f"   - Valid orders (within {date_range_days} days, completed): {valid_orders}")
    print(f"   - First-time customer orders: {len(first_time_orders)}")
    print(f"   - Repeat customer orders: {valid_orders - len(first_time_orders)}")
    print(f"   - Noise (outside window): {noise_orders_outside_window}")
    print(f"   - Noise (incomplete): {noise_orders_incomplete}")
    
    return orders, first_time_orders