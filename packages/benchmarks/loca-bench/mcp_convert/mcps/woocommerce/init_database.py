#!/usr/bin/env python3
"""
Initialize WooCommerce database with demo data
"""

import json
import os
import sys
from datetime import datetime, timedelta


def check_database_initialized(data_dir: str) -> bool:
    """Check if the database has been initialized"""
    required_files = [
        "products.json",
        "orders.json",
        "customers.json",
        "coupons.json"
    ]
    
    for filename in required_files:
        filepath = os.path.join(data_dir, filename)
        if not os.path.exists(filepath):
            return False
    
    return True


def initialize_database(data_dir: str, verbose: bool = False, include_demo_data: bool = True):
    """Initialize the database with or without demo data
    
    Args:
        data_dir: Directory to store database files
        verbose: Print verbose output
        include_demo_data: Whether to include demo products (default: True)
    """
    
    os.makedirs(data_dir, exist_ok=True)
    
    def save_json(filename, data):
        filepath = os.path.join(data_dir, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        if verbose:
            print(f"Created {filename}", file=sys.stderr)
    
    # Current timestamp
    now = datetime.now().isoformat()
    
    # Dates for testing low-selling products (120 days ago)
    old_date = (datetime.now() - timedelta(days=120)).isoformat()
    medium_date = (datetime.now() - timedelta(days=60)).isoformat()
    
    # Initialize products (including low-selling products for testing)
    products = {}
    
    if include_demo_data:
        products = {
        "1": {
            "id": 1,
            "name": "Vintage Camera Case",
            "slug": "vintage-camera-case",
            "type": "simple",
            "status": "publish",
            "featured": False,
            "catalog_visibility": "visible",
            "description": "Classic vintage-style camera case with premium leather.",
            "short_description": "Protect your camera in style.",
            "sku": "VCC-001",
            "price": "79.99",
            "regular_price": "99.99",
            "sale_price": "79.99",
            "on_sale": True,
            "manage_stock": True,
            "stock_quantity": 45,
            "stock_status": "instock",
            "categories": [{"id": 2, "name": "Accessories"}],
            "tags": [{"id": 7, "name": "Vintage"}, {"id": 8, "name": "Camera"}],
            "images": [{"src": "https://example.com/camera-case.jpg", "alt": "Vintage Camera Case"}],
            "date_created": old_date,
            "date_modified": now,
            "meta_data": [
                {"key": "sales_last_30_days", "value": "3"}
            ]
        },
        "2": {
            "id": 2,
            "name": "Retro Desk Lamp",
            "slug": "retro-desk-lamp",
            "type": "simple",
            "status": "publish",
            "featured": False,
            "catalog_visibility": "visible",
            "description": "Stylish retro desk lamp with adjustable brightness.",
            "short_description": "Add vintage charm to your workspace.",
            "sku": "RDL-002",
            "price": "59.99",
            "regular_price": "89.99",
            "sale_price": "59.99",
            "on_sale": True,
            "manage_stock": True,
            "stock_quantity": 28,
            "stock_status": "instock",
            "categories": [{"id": 5, "name": "Home & Office"}],
            "tags": [{"id": 7, "name": "Vintage"}, {"id": 9, "name": "Lighting"}],
            "images": [{"src": "https://example.com/desk-lamp.jpg", "alt": "Retro Desk Lamp"}],
            "date_created": old_date,
            "date_modified": now,
            "meta_data": [
                {"key": "sales_last_30_days", "value": "5"}
            ]
        },
        "3": {
            "id": 3,
            "name": "Classic Typewriter Keyboard",
            "slug": "classic-typewriter-keyboard",
            "type": "simple",
            "status": "publish",
            "featured": False,
            "catalog_visibility": "visible",
            "description": "Mechanical keyboard with vintage typewriter design.",
            "short_description": "Type in classic style.",
            "sku": "CTK-003",
            "price": "129.99",
            "regular_price": "149.99",
            "sale_price": "129.99",
            "on_sale": True,
            "manage_stock": True,
            "stock_quantity": 15,
            "stock_status": "instock",
            "categories": [{"id": 1, "name": "Electronics"}, {"id": 5, "name": "Home & Office"}],
            "tags": [{"id": 7, "name": "Vintage"}, {"id": 10, "name": "Keyboard"}],
            "images": [{"src": "https://example.com/typewriter-keyboard.jpg", "alt": "Typewriter Keyboard"}],
            "date_created": old_date,
            "date_modified": now,
            "meta_data": [
                {"key": "sales_last_30_days", "value": "2"}
            ]
        },
        "4": {
            "id": 4,
            "name": "Wireless Bluetooth Headphones",
            "slug": "wireless-bluetooth-headphones",
            "type": "simple",
            "status": "publish",
            "featured": True,
            "catalog_visibility": "visible",
            "description": "High-quality wireless Bluetooth headphones with noise cancellation.",
            "short_description": "Premium wireless headphones with superior sound quality.",
            "sku": "WH-BT-001",
            "price": "89.99",
            "regular_price": "89.99",
            "sale_price": "",
            "on_sale": False,
            "manage_stock": True,
            "stock_quantity": 50,
            "stock_status": "instock",
            "categories": [{"id": 1, "name": "Electronics"}],
            "tags": [{"id": 1, "name": "Wireless"}, {"id": 2, "name": "Audio"}],
            "images": [{"src": "https://example.com/headphones.jpg", "alt": "Wireless Headphones"}],
            "date_created": medium_date,
            "date_modified": now,
            "meta_data": [
                {"key": "sales_last_30_days", "value": "25"}
            ]
        },
        "5": {
            "id": 5,
            "name": "Smart Watch Pro",
            "slug": "smart-watch-pro",
            "type": "simple",
            "status": "publish",
            "featured": True,
            "catalog_visibility": "visible",
            "description": "Advanced smartwatch with fitness tracking and notifications.",
            "short_description": "Stay connected with this feature-rich smartwatch.",
            "sku": "SW-PRO-002",
            "price": "199.99",
            "regular_price": "249.99",
            "sale_price": "199.99",
            "on_sale": True,
            "manage_stock": True,
            "stock_quantity": 30,
            "stock_status": "instock",
            "categories": [{"id": 1, "name": "Electronics"}, {"id": 3, "name": "Wearables"}],
            "tags": [{"id": 3, "name": "Smart"}, {"id": 4, "name": "Fitness"}],
            "images": [{"src": "https://example.com/smartwatch.jpg", "alt": "Smart Watch"}],
            "date_created": now,
            "date_modified": now,
            "meta_data": [
                {"key": "sales_last_30_days", "value": "45"}
            ]
        },
        "6": {
            "id": 6,
            "name": "Portable Power Bank 20000mAh",
            "slug": "portable-power-bank",
            "type": "simple",
            "status": "publish",
            "featured": False,
            "catalog_visibility": "visible",
            "description": "High-capacity portable charger for all your devices.",
            "short_description": "Never run out of battery with this powerful power bank.",
            "sku": "PB-20K-003",
            "price": "45.99",
            "regular_price": "45.99",
            "sale_price": "",
            "on_sale": False,
            "manage_stock": True,
            "stock_quantity": 100,
            "stock_status": "instock",
            "categories": [{"id": 1, "name": "Electronics"}, {"id": 2, "name": "Accessories"}],
            "tags": [{"id": 5, "name": "Portable"}, {"id": 6, "name": "Charger"}],
            "images": [{"src": "https://example.com/powerbank.jpg", "alt": "Power Bank"}],
            "date_created": now,
            "date_modified": now,
            "meta_data": [
                {"key": "sales_last_30_days", "value": "38"}
            ]
        }
        }
    
    save_json("products.json", products)
    
    # Initialize categories
    categories = {
        "1": {
            "id": 1,
            "name": "Electronics",
            "slug": "electronics",
            "description": "Electronic devices and gadgets",
            "parent": 0,
            "count": 4,
            "display": "default"
        },
        "2": {
            "id": 2,
            "name": "Accessories",
            "slug": "accessories",
            "description": "Device accessories",
            "parent": 0,
            "count": 2,
            "display": "default"
        },
        "3": {
            "id": 3,
            "name": "Wearables",
            "slug": "wearables",
            "description": "Wearable technology",
            "parent": 1,
            "count": 1,
            "display": "default"
        },
        "4": {
            "id": 4,
            "name": "Outlet/Clearance",
            "slug": "outlet-clearance",
            "description": "Products on clearance and special outlet deals",
            "parent": 0,
            "count": 0,
            "display": "default"
        },
        "5": {
            "id": 5,
            "name": "Home & Office",
            "slug": "home-office",
            "description": "Products for home and office use",
            "parent": 0,
            "count": 2,
            "display": "default"
        }
    }
    save_json("categories.json", categories)
    
    # Initialize tags
    tags = {
        "1": {"id": 1, "name": "Wireless", "slug": "wireless", "count": 1},
        "2": {"id": 2, "name": "Audio", "slug": "audio", "count": 1},
        "3": {"id": 3, "name": "Smart", "slug": "smart", "count": 1},
        "4": {"id": 4, "name": "Fitness", "slug": "fitness", "count": 1},
        "5": {"id": 5, "name": "Portable", "slug": "portable", "count": 1},
        "6": {"id": 6, "name": "Charger", "slug": "charger", "count": 1},
        "7": {"id": 7, "name": "Vintage", "slug": "vintage", "count": 3},
        "8": {"id": 8, "name": "Camera", "slug": "camera", "count": 1},
        "9": {"id": 9, "name": "Lighting", "slug": "lighting", "count": 1},
        "10": {"id": 10, "name": "Keyboard", "slug": "keyboard", "count": 1}
    }
    save_json("tags.json", tags)
    
    # Initialize reviews
    reviews = {
        "1": {
            "id": 1,
            "product_id": 1,
            "reviewer": "John Doe",
            "reviewer_email": "john@example.com",
            "review": "Excellent sound quality and comfortable to wear!",
            "rating": 5,
            "status": "approved",
            "date_created": now
        },
        "2": {
            "id": 2,
            "product_id": 2,
            "reviewer": "Jane Smith",
            "reviewer_email": "jane@example.com",
            "review": "Great smartwatch with lots of features. Battery life is good.",
            "rating": 4,
            "status": "approved",
            "date_created": now
        }
    }
    save_json("reviews.json", reviews)
    
    # Initialize variations (empty for now)
    save_json("variations.json", {})
    
    # Initialize customers
    customers = {}
    if include_demo_data:
        customers = {
            "1": {
                "id": 1,
                "email": "customer1@example.com",
                "first_name": "John",
                "last_name": "Doe",
                "username": "johndoe",
                "role": "customer",
                "date_created": now,
                "date_modified": now,
                "billing": {
                    "first_name": "John",
                    "last_name": "Doe",
                    "company": "",
                    "address_1": "123 Main St",
                    "address_2": "",
                    "city": "New York",
                    "state": "NY",
                    "postcode": "10001",
                    "country": "US",
                    "email": "customer1@example.com",
                    "phone": "555-0001"
                },
                "shipping": {
                    "first_name": "John",
                    "last_name": "Doe",
                    "company": "",
                    "address_1": "123 Main St",
                    "address_2": "",
                    "city": "New York",
                    "state": "NY",
                    "postcode": "10001",
                    "country": "US"
                },
                "meta_data": []
            },
            "2": {
                "id": 2,
                "email": "customer2@example.com",
                "first_name": "Jane",
                "last_name": "Smith",
                "username": "janesmith",
                "role": "customer",
                "date_created": now,
                "date_modified": now,
                "billing": {
                    "first_name": "Jane",
                    "last_name": "Smith",
                    "company": "Tech Corp",
                    "address_1": "456 Oak Ave",
                    "address_2": "Suite 200",
                    "city": "San Francisco",
                    "state": "CA",
                    "postcode": "94102",
                    "country": "US",
                    "email": "customer2@example.com",
                    "phone": "555-0002"
                },
                "shipping": {
                    "first_name": "Jane",
                    "last_name": "Smith",
                    "company": "Tech Corp",
                    "address_1": "456 Oak Ave",
                    "address_2": "Suite 200",
                    "city": "San Francisco",
                    "state": "CA",
                    "postcode": "94102",
                    "country": "US"
                },
                "meta_data": []
            }
        }
    save_json("customers.json", customers)
    
    # Initialize orders
    orders = {}
    if include_demo_data:
        yesterday = (datetime.now() - timedelta(days=1)).isoformat()
        orders = {
            "1": {
                "id": 1,
                "number": "1001",
                "status": "completed",
                "currency": "USD",
                "date_created": yesterday,
                "date_modified": yesterday,
                "date_completed": yesterday,
                "customer_id": 1,
                "billing": customers["1"]["billing"],
                "shipping": customers["1"]["shipping"],
                "payment_method": "bacs",
                "payment_method_title": "Direct Bank Transfer",
                "line_items": [
                    {
                        "id": 1,
                        "name": "Wireless Bluetooth Headphones",
                        "product_id": 1,
                        "quantity": 1,
                        "price": 89.99,
                        "subtotal": "89.99",
                        "total": "89.99"
                    }
                ],
                "shipping_lines": [],
                "tax_lines": [],
                "fee_lines": [],
                "coupon_lines": [],
                "refunds": [],
                "total": "89.99",
                "subtotal": "89.99",
                "discount_total": "0.00",
                "shipping_total": "0.00",
                "cart_tax": "0.00",
                "total_tax": "0.00"
            },
            "2": {
                "id": 2,
                "number": "1002",
                "status": "processing",
                "currency": "USD",
                "date_created": now,
                "date_modified": now,
                "customer_id": 2,
                "billing": customers["2"]["billing"],
                "shipping": customers["2"]["shipping"],
                "payment_method": "stripe",
                "payment_method_title": "Credit Card",
                "line_items": [
                    {
                        "id": 2,
                        "name": "Smart Watch Pro",
                        "product_id": 2,
                        "quantity": 1,
                        "price": 199.99,
                        "subtotal": "199.99",
                        "total": "199.99"
                    },
                    {
                        "id": 3,
                        "name": "Portable Power Bank 20000mAh",
                        "product_id": 3,
                        "quantity": 2,
                        "price": 45.99,
                        "subtotal": "91.98",
                        "total": "91.98"
                    }
                ],
                "shipping_lines": [
                    {
                        "id": 1,
                        "method_title": "Flat Rate",
                        "total": "10.00"
                    }
                ],
                "tax_lines": [],
                "fee_lines": [],
                "coupon_lines": [],
                "refunds": [],
                "total": "301.97",
                "subtotal": "291.97",
                "discount_total": "0.00",
                "shipping_total": "10.00",
                "cart_tax": "0.00",
                "total_tax": "0.00"
            }
        }
    save_json("orders.json", orders)
    
    # Initialize order notes
    save_json("order_notes.json", {})
    
    # Initialize refunds
    save_json("refunds.json", {})
    
    # Initialize coupons
    future_date = (datetime.now() + timedelta(days=30)).isoformat()
    coupons = {
        "1": {
            "id": 1,
            "code": "SUMMER20",
            "discount_type": "percent",
            "amount": "20",
            "date_created": now,
            "date_modified": now,
            "date_expires": future_date,
            "individual_use": False,
            "product_ids": [],
            "excluded_product_ids": [],
            "usage_limit": 100,
            "usage_limit_per_user": 1,
            "limit_usage_to_x_items": None,
            "free_shipping": False,
            "exclude_sale_items": False,
            "usage_count": 5,
            "minimum_amount": "50.00"
        },
        "2": {
            "id": 2,
            "code": "FREESHIP",
            "discount_type": "fixed_cart",
            "amount": "0",
            "date_created": now,
            "date_modified": now,
            "date_expires": None,
            "individual_use": False,
            "product_ids": [],
            "excluded_product_ids": [],
            "usage_limit": None,
            "usage_limit_per_user": None,
            "limit_usage_to_x_items": None,
            "free_shipping": True,
            "exclude_sale_items": False,
            "usage_count": 12,
            "minimum_amount": "100.00"
        }
    }
    save_json("coupons.json", coupons)
    
    # Initialize shipping zones
    shipping_zones = {
        "1": {
            "id": 1,
            "name": "United States",
            "order": 0
        },
        "2": {
            "id": 2,
            "name": "International",
            "order": 1
        }
    }
    save_json("shipping_zones.json", shipping_zones)
    
    # Initialize shipping methods
    shipping_methods = {
        "1": {
            "id": 1,
            "zone_id": 1,
            "method_id": "flat_rate",
            "method_title": "Flat Rate",
            "enabled": True,
            "settings": {
                "cost": {"value": "10.00"}
            }
        },
        "2": {
            "id": 2,
            "zone_id": 1,
            "method_id": "free_shipping",
            "method_title": "Free Shipping",
            "enabled": True,
            "settings": {
                "min_amount": {"value": "100.00"}
            }
        },
        "3": {
            "id": 3,
            "zone_id": 2,
            "method_id": "flat_rate",
            "method_title": "International Shipping",
            "enabled": True,
            "settings": {
                "cost": {"value": "25.00"}
            }
        }
    }
    save_json("shipping_methods.json", shipping_methods)
    
    # Initialize tax rates
    tax_rates = {
        "1": {
            "id": 1,
            "country": "US",
            "state": "CA",
            "rate": "7.5",
            "name": "California Sales Tax",
            "priority": 1,
            "compound": False,
            "shipping": True,
            "class": "standard"
        },
        "2": {
            "id": 2,
            "country": "US",
            "state": "NY",
            "rate": "8.875",
            "name": "New York Sales Tax",
            "priority": 1,
            "compound": False,
            "shipping": True,
            "class": "standard"
        }
    }
    save_json("tax_rates.json", tax_rates)
    
    # Initialize tax classes
    tax_classes = {
        "1": {
            "slug": "standard",
            "name": "Standard Rate"
        },
        "2": {
            "slug": "reduced",
            "name": "Reduced Rate"
        },
        "3": {
            "slug": "zero",
            "name": "Zero Rate"
        }
    }
    save_json("tax_classes.json", tax_classes)
    
    # Initialize settings
    settings = {
        "general": [
            {"id": "store_address", "label": "Address line 1", "value": "123 Store St"},
            {"id": "store_city", "label": "City", "value": "Commerce City"},
            {"id": "store_country", "label": "Country / State", "value": "US:CA"}
        ],
        "products": [
            {"id": "weight_unit", "label": "Weight unit", "value": "lbs"},
            {"id": "dimension_unit", "label": "Dimensions unit", "value": "in"}
        ],
        "tax": [
            {"id": "prices_include_tax", "label": "Prices include tax", "value": "no"},
            {"id": "tax_based_on", "label": "Calculate tax based on", "value": "shipping"}
        ],
        "shipping": [
            {"id": "shipping_cost_requires_address", "label": "Shipping destination", "value": "yes"}
        ],
        "checkout": [
            {"id": "enable_guest_checkout", "label": "Enable guest checkout", "value": "yes"},
            {"id": "enable_terms_and_conditions", "label": "Terms and conditions", "value": "no"}
        ]
    }
    save_json("settings.json", settings)
    
    # Initialize payment gateways
    payment_gateways = {
        "bacs": {
            "id": "bacs",
            "title": "Direct Bank Transfer",
            "description": "Make your payment directly into our bank account.",
            "enabled": True,
            "settings": {}
        },
        "cheque": {
            "id": "cheque",
            "title": "Check Payments",
            "description": "Please send a check to our store address.",
            "enabled": False,
            "settings": {}
        },
        "cod": {
            "id": "cod",
            "title": "Cash on Delivery",
            "description": "Pay with cash upon delivery.",
            "enabled": True,
            "settings": {}
        },
        "stripe": {
            "id": "stripe",
            "title": "Credit Card (Stripe)",
            "description": "Pay with your credit card via Stripe.",
            "enabled": True,
            "settings": {}
        }
    }
    save_json("payment_gateways.json", payment_gateways)
    
    # Initialize webhooks
    save_json("webhooks.json", {})
    
    # Initialize system tools
    system_tools = {
        "clear_transients": {
            "id": "clear_transients",
            "name": "Clear Transients",
            "description": "Clear all transient cache"
        },
        "clear_expired_transients": {
            "id": "clear_expired_transients",
            "name": "Clear Expired Transients",
            "description": "Clear expired transient cache"
        },
        "recount_terms": {
            "id": "recount_terms",
            "name": "Recount Terms",
            "description": "Recount product terms"
        }
    }
    save_json("system_tools.json", system_tools)
    
    if verbose:
        print("Database initialization complete!", file=sys.stderr)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Initialize WooCommerce database")
    parser.add_argument("--data-dir", default="./data", help="Data directory path")
    parser.add_argument("--force", action="store_true", help="Force re-initialization")
    
    args = parser.parse_args()
    
    if args.force or not check_database_initialized(args.data_dir):
        initialize_database(args.data_dir, verbose=True)
        print(f"Database initialized in: {args.data_dir}")
    else:
        print(f"Database already initialized in: {args.data_dir}")
        print("Use --force to re-initialize")


