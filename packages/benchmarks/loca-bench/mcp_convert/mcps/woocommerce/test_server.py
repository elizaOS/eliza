#!/usr/bin/env python3
"""
Tests for WooCommerce MCP Server
"""

import sys
import os
import json
import tempfile
import shutil

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from mcps.woocommerce.database_utils import WooCommerceDatabase
from mcps.woocommerce.init_database import initialize_database


def setup_test_database():
    """Create a temporary test database"""
    temp_dir = tempfile.mkdtemp()
    initialize_database(temp_dir, verbose=False)
    return temp_dir


def cleanup_test_database(temp_dir):
    """Clean up temporary test database"""
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)


def test_products():
    """Test product operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test list products
        products = db.list_products()
        assert len(products) > 0, "Should have products"
        print(f"✓ List products: {len(products)} products found")
        
        # Test get product
        product = db.get_product(1)
        assert product is not None, "Product 1 should exist"
        assert product['name'] == "Wireless Bluetooth Headphones"
        print(f"✓ Get product: {product['name']}")
        
        # Test create product
        new_product = db.create_product({
            "name": "Test Product",
            "regular_price": "99.99",
            "sku": "TEST-001"
        })
        assert new_product['id'] is not None
        print(f"✓ Create product: ID {new_product['id']}")
        
        # Test update product
        updated = db.update_product(new_product['id'], {"name": "Updated Test Product"})
        assert updated['name'] == "Updated Test Product"
        print(f"✓ Update product: {updated['name']}")
        
        # Test delete product
        deleted = db.delete_product(new_product['id'])
        assert deleted['id'] == new_product['id']
        print(f"✓ Delete product: ID {deleted['id']}")
        
        # Test filters
        featured = db.list_products({"featured": True})
        assert len(featured) > 0, "Should have featured products"
        print(f"✓ Filter featured: {len(featured)} products")
        
        on_sale = db.list_products({"onSale": True})
        assert len(on_sale) > 0, "Should have on-sale products"
        print(f"✓ Filter on sale: {len(on_sale)} products")
        
    finally:
        cleanup_test_database(temp_dir)


def test_orders():
    """Test order operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test list orders
        orders = db.list_orders()
        assert len(orders) > 0, "Should have orders"
        print(f"✓ List orders: {len(orders)} orders found")
        
        # Test get order
        order = db.get_order(1)
        assert order is not None, "Order 1 should exist"
        print(f"✓ Get order: Order #{order['number']}")
        
        # Test create order
        new_order = db.create_order({
            "customer_id": 1,
            "line_items": [
                {"product_id": 1, "quantity": 2, "price": 89.99}
            ]
        })
        assert new_order['id'] is not None
        print(f"✓ Create order: ID {new_order['id']}")
        
        # Test update order
        updated = db.update_order(new_order['id'], {"status": "processing"})
        assert updated['status'] == "processing"
        print(f"✓ Update order: Status {updated['status']}")
        
        # Test order note
        note = db.create_order_note(new_order['id'], {
            "note": "Test order note",
            "customer_note": False
        })
        assert note['note'] == "Test order note"
        print(f"✓ Create order note: {note['note']}")
        
        # Test filter by status
        completed = db.list_orders({"status": ["completed"]})
        assert len(completed) > 0, "Should have completed orders"
        print(f"✓ Filter by status: {len(completed)} completed orders")
        
    finally:
        cleanup_test_database(temp_dir)


def test_customers():
    """Test customer operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test list customers
        customers = db.list_customers()
        assert len(customers) > 0, "Should have customers"
        print(f"✓ List customers: {len(customers)} customers found")
        
        # Test get customer
        customer = db.get_customer(1)
        assert customer is not None, "Customer 1 should exist"
        print(f"✓ Get customer: {customer['email']}")
        
        # Test create customer
        new_customer = db.create_customer({
            "email": "test@example.com",
            "first_name": "Test",
            "last_name": "User"
        })
        assert new_customer['id'] is not None
        print(f"✓ Create customer: {new_customer['email']}")
        
        # Test update customer
        updated = db.update_customer(new_customer['id'], {"first_name": "Updated"})
        assert updated['first_name'] == "Updated"
        print(f"✓ Update customer: {updated['first_name']}")
        
        # Test search
        results = db.list_customers({"search": "john"})
        assert len(results) > 0, "Should find customers"
        print(f"✓ Search customers: {len(results)} results")
        
    finally:
        cleanup_test_database(temp_dir)


def test_coupons():
    """Test coupon operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test list coupons
        coupons = db.list_coupons()
        assert len(coupons) > 0, "Should have coupons"
        print(f"✓ List coupons: {len(coupons)} coupons found")
        
        # Test get coupon
        coupon = db.get_coupon(1)
        assert coupon is not None, "Coupon 1 should exist"
        print(f"✓ Get coupon: {coupon['code']}")
        
        # Test create coupon
        new_coupon = db.create_coupon({
            "code": "TEST50",
            "discount_type": "percent",
            "amount": "50"
        })
        assert new_coupon['id'] is not None
        print(f"✓ Create coupon: {new_coupon['code']}")
        
        # Test update coupon
        updated = db.update_coupon(new_coupon['id'], {"amount": "25"})
        assert updated['amount'] == "25"
        print(f"✓ Update coupon: {updated['amount']}% discount")
        
        # Test delete coupon
        deleted = db.delete_coupon(new_coupon['id'])
        assert deleted['id'] == new_coupon['id']
        print(f"✓ Delete coupon: {deleted['code']}")
        
    finally:
        cleanup_test_database(temp_dir)


def test_categories_and_tags():
    """Test categories and tags"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test list categories
        categories = db.list_categories()
        assert len(categories) > 0, "Should have categories"
        print(f"✓ List categories: {len(categories)} categories found")
        
        # Test create category
        new_category = db.create_category({
            "name": "Test Category",
            "slug": "test-category"
        })
        assert new_category['id'] is not None
        print(f"✓ Create category: {new_category['name']}")
        
        # Test list tags
        tags = db.list_tags()
        assert len(tags) > 0, "Should have tags"
        print(f"✓ List tags: {len(tags)} tags found")
        
    finally:
        cleanup_test_database(temp_dir)


def test_shipping():
    """Test shipping operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test list shipping zones
        zones = db.list_shipping_zones()
        assert len(zones) > 0, "Should have shipping zones"
        print(f"✓ List shipping zones: {len(zones)} zones found")
        
        # Test get shipping zone
        zone = db.get_shipping_zone(1)
        assert zone is not None, "Zone 1 should exist"
        print(f"✓ Get shipping zone: {zone['name']}")
        
        # Test create shipping zone
        new_zone = db.create_shipping_zone({"name": "Europe"})
        assert new_zone['id'] is not None
        print(f"✓ Create shipping zone: {new_zone['name']}")
        
        # Test list zone methods
        methods = db.list_shipping_zone_methods(1)
        assert len(methods) > 0, "Should have shipping methods"
        print(f"✓ List zone methods: {len(methods)} methods found")
        
    finally:
        cleanup_test_database(temp_dir)


def test_tax():
    """Test tax operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test list tax rates
        rates = db.list_tax_rates()
        assert len(rates) > 0, "Should have tax rates"
        print(f"✓ List tax rates: {len(rates)} rates found")
        
        # Test get tax rate
        rate = db.get_tax_rate(1)
        assert rate is not None, "Rate 1 should exist"
        print(f"✓ Get tax rate: {rate['name']}")
        
        # Test create tax rate
        new_rate = db.create_tax_rate({
            "country": "US",
            "state": "TX",
            "rate": "8.25",
            "name": "Texas Sales Tax"
        })
        assert new_rate['id'] is not None
        print(f"✓ Create tax rate: {new_rate['name']}")
        
        # Test list tax classes
        classes = db.list_tax_classes()
        assert len(classes) > 0, "Should have tax classes"
        print(f"✓ List tax classes: {len(classes)} classes found")
        
    finally:
        cleanup_test_database(temp_dir)


def test_reports():
    """Test report operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test sales report
        sales = db.get_sales_report()
        assert 'total_sales' in sales
        print(f"✓ Sales report: ${sales['total_sales']}")
        
        # Test top sellers
        top_sellers = db.get_top_sellers_report()
        assert len(top_sellers) >= 0
        print(f"✓ Top sellers report: {len(top_sellers)} products")
        
        # Test customers report
        customers_report = db.get_customers_report()
        assert 'total_customers' in customers_report
        print(f"✓ Customers report: {customers_report['total_customers']} customers")
        
        # Test orders report
        orders_report = db.get_orders_report()
        assert 'total_orders' in orders_report
        print(f"✓ Orders report: {orders_report['total_orders']} orders")
        
        # Test stock report
        stock = db.get_stock_report()
        assert isinstance(stock, list)
        print(f"✓ Stock report: {len(stock)} products")
        
        # Test low stock report
        low_stock = db.get_low_stock_report()
        assert isinstance(low_stock, list)
        print(f"✓ Low stock report: {len(low_stock)} products")
        
    finally:
        cleanup_test_database(temp_dir)


def test_system():
    """Test system operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test system status
        status = db.get_system_status()
        assert 'environment' in status
        print(f"✓ System status: Version {status['environment']['version']}")
        
        # Test list system tools
        tools = db.list_system_tools()
        assert len(tools) > 0, "Should have system tools"
        print(f"✓ List system tools: {len(tools)} tools found")
        
        # Test settings groups
        groups = db.list_settings_groups()
        assert len(groups) > 0, "Should have settings groups"
        print(f"✓ List settings groups: {len(groups)} groups found")
        
        # Test get settings
        settings = db.get_settings_group("general")
        assert isinstance(settings, list)
        print(f"✓ Get settings: {len(settings)} settings in general group")
        
        # Test payment gateways
        gateways = db.list_payment_gateways()
        assert len(gateways) > 0, "Should have payment gateways"
        print(f"✓ List payment gateways: {len(gateways)} gateways found")
        
        gateway = db.get_payment_gateway("bacs")
        assert gateway is not None
        print(f"✓ Get payment gateway: {gateway['title']}")
        
    finally:
        cleanup_test_database(temp_dir)


def test_batch_operations():
    """Test batch operations"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test batch product update
        batch_result = db.batch_update_products({
            "create": [
                {"name": "Batch Product 1", "regular_price": "10.00"},
                {"name": "Batch Product 2", "regular_price": "20.00"}
            ],
            "update": [],
            "delete": []
        })
        assert len(batch_result['create']) == 2
        print(f"✓ Batch create products: {len(batch_result['create'])} products created")
        
        # Test batch order update
        batch_order_result = db.batch_update_orders({
            "create": [
                {
                    "customer_id": 1,
                    "line_items": [{"product_id": 1, "quantity": 1, "price": 89.99}]
                }
            ],
            "update": [],
            "delete": []
        })
        assert len(batch_order_result['create']) == 1
        print(f"✓ Batch create orders: {len(batch_order_result['create'])} orders created")
        
    finally:
        cleanup_test_database(temp_dir)


def test_pagination():
    """Test pagination"""
    temp_dir = setup_test_database()
    try:
        db = WooCommerceDatabase(temp_dir)
        
        # Test product pagination
        page1 = db.list_products({"perPage": 1, "page": 1})
        assert len(page1) == 1
        print(f"✓ Product pagination page 1: {len(page1)} products")
        
        page2 = db.list_products({"perPage": 1, "page": 2})
        assert len(page2) == 1
        if page1[0]['id'] != page2[0]['id']:
            print(f"✓ Product pagination page 2: Different product")
        
        # Test order pagination
        orders_page1 = db.list_orders({"perPage": 1, "page": 1})
        assert len(orders_page1) == 1
        print(f"✓ Order pagination: {len(orders_page1)} orders per page")
        
    finally:
        cleanup_test_database(temp_dir)


def run_all_tests():
    """Run all tests"""
    tests = [
        ("Products", test_products),
        ("Orders", test_orders),
        ("Customers", test_customers),
        ("Coupons", test_coupons),
        ("Categories & Tags", test_categories_and_tags),
        ("Shipping", test_shipping),
        ("Tax", test_tax),
        ("Reports", test_reports),
        ("System", test_system),
        ("Batch Operations", test_batch_operations),
        ("Pagination", test_pagination)
    ]
    
    print("=" * 60)
    print("WooCommerce MCP Server - Test Suite")
    print("=" * 60)
    
    passed = 0
    failed = 0
    
    for test_name, test_func in tests:
        print(f"\nTesting {test_name}...")
        print("-" * 60)
        try:
            test_func()
            passed += 1
            print(f"✓ {test_name} tests passed")
        except AssertionError as e:
            failed += 1
            print(f"✗ {test_name} tests failed: {e}")
        except Exception as e:
            failed += 1
            print(f"✗ {test_name} tests error: {e}")
    
    print("\n" + "=" * 60)
    print(f"Test Results: {passed} passed, {failed} failed")
    print("=" * 60)
    
    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
