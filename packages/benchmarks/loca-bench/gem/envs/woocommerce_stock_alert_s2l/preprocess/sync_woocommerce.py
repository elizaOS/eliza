#!/usr/bin/env python3
"""
WooCommerce synchronization script for stock alert task.
This script initializes WooCommerce products by checking existing products,
comparing with woocommerce_products.json, and creating/updating as needed.
"""

import json
import os
import sys
import asyncio
from argparse import ArgumentParser

# Mock WooCommerce client for demonstration
# In real implementation, you would use the WooCommerce REST API
class WooCommerceClient:
    """Mock WooCommerce client for product management"""

    def __init__(self):
        self.products = {}  # Mock product storage
        print("WooCommerce client initialized")

    def get_product_by_sku(self, sku):
        """Get product by SKU"""
        return self.products.get(sku)

    def create_product(self, product_data):
        """Create a new product"""
        sku = product_data['sku']
        wc_product = {
            'id': product_data['id'],
            'name': product_data['name'],
            'sku': sku,
            'stock_quantity': product_data['stock_quantity'],
            'stock_threshold': product_data['stock_threshold'],
            'supplier': product_data['supplier'],
            'price': product_data['price'],
            'category': product_data['category']
        }
        self.products[sku] = wc_product
        return wc_product

    def update_product(self, sku, updates):
        """Update existing product"""
        if sku in self.products:
            self.products[sku].update(updates)
            return self.products[sku]
        return None

    def list_all_products(self):
        """List all products"""
        return list(self.products.values())

def load_woocommerce_products():
    """Load products from woocommerce_products.json"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    products_file = os.path.join(script_dir, '..', 'initial_workspace', 'woocommerce_products.json')

    if not os.path.exists(products_file):
        raise FileNotFoundError(f"Products file not found: {products_file}")

    with open(products_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    return data['products']

def compare_product_data(wc_product, target_product):
    """Compare WooCommerce product with target product data"""
    critical_fields = ['stock_quantity', 'stock_threshold']

    differences = {}
    for field in critical_fields:
        if field == 'stock_threshold':
            # stock_threshold might be stored in meta_data or as a direct field
            wc_value = wc_product.get('stock_threshold')
        else:
            wc_value = wc_product.get(field)

        target_value = target_product.get(field)

        if wc_value != target_value:
            differences[field] = {
                'current': wc_value,
                'target': target_value
            }

    # Check supplier information
    wc_supplier = wc_product.get('supplier', {})
    target_supplier = target_product.get('supplier', {})

    supplier_fields = ['name', 'contact', 'supplier_id']
    for field in supplier_fields:
        wc_value = wc_supplier.get(field)
        target_value = target_supplier.get(field)

        if wc_value != target_value:
            if 'supplier' not in differences:
                differences['supplier'] = {}
            differences['supplier'][field] = {
                'current': wc_value,
                'target': target_value
            }

    return differences

async def sync_woocommerce_products():
    """Synchronize WooCommerce products with target data"""
    print("Starting WooCommerce product synchronization...")

    # Load target products
    target_products = load_woocommerce_products()
    print(f"Loaded {len(target_products)} target products from configuration")

    # Initialize WooCommerce client
    wc_client = WooCommerceClient()

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
            # Check if product exists
            existing_product = wc_client.get_product_by_sku(sku)

            if existing_product:
                print(f"Found existing product: {product_name} (SKU: {sku})")

                # Compare data
                differences = compare_product_data(existing_product, target_product)

                if differences:
                    print(f"  - Product needs updates: {list(differences.keys())}")

                    # Prepare updates
                    updates = {}
                    if 'stock_quantity' in differences:
                        updates['stock_quantity'] = target_product['stock_quantity']
                    if 'stock_threshold' in differences:
                        updates['stock_threshold'] = target_product['stock_threshold']
                    if 'supplier' in differences:
                        updates['supplier'] = target_product['supplier']

                    # Update product
                    updated_product = wc_client.update_product(sku, updates)
                    if updated_product:
                        print(f"  ✅ Updated product: {product_name}")
                        stats['updated'] += 1
                    else:
                        print(f"  ❌ Failed to update product: {product_name}")
                        stats['errors'] += 1
                else:
                    print(f"  ✅ Product is up to date: {product_name}")
                    stats['existing_valid'] += 1
            else:
                print(f"Creating new product: {product_name} (SKU: {sku})")

                # Create new product
                created_product = wc_client.create_product(target_product)
                if created_product:
                    print(f"  ✅ Created product: {product_name}")
                    stats['created'] += 1
                else:
                    print(f"  ❌ Failed to create product: {product_name}")
                    stats['errors'] += 1

        except Exception as e:
            print(f"  ❌ Error processing product {product_name}: {e}")
            stats['errors'] += 1

    # Summary
    print(f"\n{'='*60}")
    print("WOOCOMMERCE SYNCHRONIZATION SUMMARY")
    print(f"{'='*60}")
    print(f"Products already valid: {stats['existing_valid']}")
    print(f"Products created: {stats['created']}")
    print(f"Products updated: {stats['updated']}")
    print(f"Errors encountered: {stats['errors']}")
    print(f"Total products processed: {len(target_products)}")

    # Display low stock products
    all_products = wc_client.list_all_products()
    low_stock_products = [
        p for p in all_products
        if p['stock_quantity'] < p['stock_threshold']
    ]

    if low_stock_products:
        print(f"\n⚠️ Low stock products detected ({len(low_stock_products)}):")
        for product in low_stock_products:
            print(f"  - {product['name']} (Stock: {product['stock_quantity']}, Threshold: {product['stock_threshold']})")

    # Save synchronization results
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sync_results_file = os.path.join(script_dir, 'woocommerce_sync_results.json')

    sync_results = {
        'timestamp': '2024-12-01 10:00:00',  # In real implementation, use datetime.now()
        'statistics': stats,
        'low_stock_products': [
            {
                'id': p['id'],
                'name': p['name'],
                'sku': p['sku'],
                'stock_quantity': p['stock_quantity'],
                'stock_threshold': p['stock_threshold'],
                'supplier': p['supplier']
            }
            for p in low_stock_products
        ]
    }

    with open(sync_results_file, 'w', encoding='utf-8') as f:
        json.dump(sync_results, f, ensure_ascii=False, indent=2)

    print(f"\nSynchronization results saved to: {sync_results_file}")

    return stats['errors'] == 0

async def main():
    """Main function"""
    parser = ArgumentParser(description="WooCommerce Product Synchronization")
    parser.add_argument("--agent_workspace", required=False,
                       help="Agent workspace directory")
    parser.add_argument("--launch_time", required=False,
                       help="Task launch time")
    args = parser.parse_args()

    print("="*60)
    print("WOOCOMMERCE PRODUCT SYNCHRONIZATION")
    print("="*60)
    print("This script will:")
    print("1. Load target products from woocommerce_products.json")
    print("2. Check existing products in WooCommerce")
    print("3. Create missing products")
    print("4. Update products with incorrect data")
    print("="*60)

    try:
        success = await sync_woocommerce_products()

        if success:
            print("\n✅ WooCommerce synchronization completed successfully!")
        else:
            print("\n❌ WooCommerce synchronization completed with errors!")
            return False

        return True

    except Exception as e:
        print(f"\n❌ WooCommerce synchronization failed: {e}")
        return False

if __name__ == "__main__":
    result = asyncio.run(main())
    sys.exit(0 if result else 1)