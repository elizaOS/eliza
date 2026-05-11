"""
WooCommerce Database Utilities

Manages local JSON data files for the simplified WooCommerce MCP server.
Provides complete WooCommerce functionality using local storage.
"""

import json
import os
import sys
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from copy import deepcopy


class WooCommerceDatabase:
    """WooCommerce database implementation using local JSON files"""
    
    def __init__(self, data_dir: str = None):
        if data_dir is None:
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        self.data_dir = data_dir
        
        # Ensure database is initialized
        self._ensure_database_initialized()
        
        # Load all data files
        self.products = self._load_json_file("products.json")
        self.categories = self._load_json_file("categories.json")
        self.tags = self._load_json_file("tags.json")
        self.reviews = self._load_json_file("reviews.json")
        self.variations = self._load_json_file("variations.json")
        
        self.orders = self._load_json_file("orders.json")
        self.order_notes = self._load_json_file("order_notes.json")
        self.refunds = self._load_json_file("refunds.json")
        
        self.customers = self._load_json_file("customers.json")
        self.coupons = self._load_json_file("coupons.json")
        
        self.shipping_zones = self._load_json_file("shipping_zones.json")
        self.shipping_methods = self._load_json_file("shipping_methods.json")
        
        self.tax_rates = self._load_json_file("tax_rates.json")
        self.tax_classes = self._load_json_file("tax_classes.json")
        
        self.settings = self._load_json_file("settings.json")
        self.payment_gateways = self._load_json_file("payment_gateways.json")
        self.webhooks = self._load_json_file("webhooks.json")
        self.system_tools = self._load_json_file("system_tools.json")

    def _ensure_database_initialized(self):
        """Ensure database is initialized, create if needed"""
        try:
            from .init_database import check_database_initialized, initialize_database
        except ImportError:
            try:
                from init_database import check_database_initialized, initialize_database
            except ImportError:
                # Database initialization not available, skip
                return

        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if not check_database_initialized(self.data_dir):
            if not quiet:
                print(f"Database not found. Initializing in: {self.data_dir}", file=sys.stderr)
            initialize_database(self.data_dir, verbose=not quiet)

    def _load_json_file(self, filename: str) -> dict:
        """Load a JSON file from the data directory"""
        filepath = os.path.join(self.data_dir, filename)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_json_file(self, filename: str, data: dict):
        """Save data to a JSON file"""
        filepath = os.path.join(self.data_dir, filename)
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def _generate_id(self, data_dict: dict) -> int:
        """Generate a new ID for a data item"""
        if not data_dict:
            return 1
        max_id = max([int(k) for k in data_dict.keys()])
        return max_id + 1

    def _get_timestamp(self) -> str:
        """Get current timestamp in ISO format"""
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    # ==================== Product Methods ====================
    
    def list_products(self, filters: dict = None) -> List[dict]:
        """List products with optional filters"""
        filters = filters or {}
        products = list(self.products.values())
        
        # Apply filters
        if filters.get('search'):
            search_term = filters['search'].lower()
            products = [p for p in products if search_term in p.get('name', '').lower()]
        
        if filters.get('status'):
            products = [p for p in products if p.get('status') == filters['status']]
        
        if filters.get('category'):
            cat_id = int(filters['category'])
            products = [p for p in products if any(c.get('id') == cat_id for c in p.get('categories', []))]
        
        if filters.get('tag'):
            tag_id = int(filters['tag'])
            products = [p for p in products if any(t.get('id') == tag_id for t in p.get('tags', []))]
        
        if filters.get('sku'):
            products = [p for p in products if p.get('sku') == filters['sku']]
        
        if filters.get('featured') is not None:
            products = [p for p in products if p.get('featured') == filters['featured']]
        
        if filters.get('onSale') is not None:
            products = [p for p in products if p.get('on_sale') == filters['onSale']]
        
        if filters.get('stockStatus'):
            products = [p for p in products if p.get('stock_status') == filters['stockStatus']]
        
        # Price filters
        if filters.get('minPrice'):
            min_price = float(filters['minPrice'])
            products = [p for p in products if float(p.get('price', 0)) >= min_price]
        
        if filters.get('maxPrice'):
            max_price = float(filters['maxPrice'])
            products = [p for p in products if float(p.get('price', 0)) <= max_price]
        
        # Sorting
        orderby = filters.get('orderby', 'date')
        order = filters.get('order', 'desc')
        
        if orderby == 'date':
            products.sort(key=lambda x: x.get('date_created', ''), reverse=(order == 'desc'))
        elif orderby == 'id':
            products.sort(key=lambda x: x.get('id', 0), reverse=(order == 'desc'))
        elif orderby == 'title' or orderby == 'name':
            products.sort(key=lambda x: x.get('name', ''), reverse=(order == 'desc'))
        elif orderby == 'price':
            products.sort(key=lambda x: float(x.get('price', 0)), reverse=(order == 'desc'))
        
        # Pagination
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return products[start_idx:end_idx]

    def get_product(self, product_id: int) -> Optional[dict]:
        """Get a specific product"""
        return self.products.get(str(product_id))

    def create_product(self, product_data: dict) -> dict:
        """Create a new product"""
        product_id = self._generate_id(self.products)
        product = {
            'id': product_id,
            'date_created': self._get_timestamp(),
            'date_modified': self._get_timestamp(),
            'status': 'publish',
            'featured': False,
            'catalog_visibility': 'visible',
            'type': 'simple',
            'stock_status': 'instock',
            'on_sale': False,
            **product_data
        }
        
        # Calculate on_sale based on prices
        if product.get('sale_price') and product.get('regular_price'):
            product['on_sale'] = float(product['sale_price']) < float(product['regular_price'])
            product['price'] = product['sale_price']
        else:
            product['price'] = product.get('regular_price', '0')
        
        self.products[str(product_id)] = product
        self._save_json_file("products.json", self.products)
        return product

    def update_product(self, product_id: int, product_data: dict) -> dict:
        """Update a product"""
        product_id_str = str(product_id)
        if product_id_str not in self.products:
            raise ValueError(f"Product {product_id} not found")
        
        product = self.products[product_id_str]
        product.update(product_data)
        product['date_modified'] = self._get_timestamp()
        
        # Recalculate on_sale
        if product.get('sale_price') and product.get('regular_price'):
            product['on_sale'] = float(product['sale_price']) < float(product['regular_price'])
            product['price'] = product['sale_price']
        elif product.get('regular_price'):
            product['price'] = product['regular_price']
        
        self._save_json_file("products.json", self.products)
        return product

    def delete_product(self, product_id: int, force: bool = False) -> dict:
        """Delete a product"""
        product_id_str = str(product_id)
        if product_id_str not in self.products:
            raise ValueError(f"Product {product_id} not found")
        
        product = self.products.pop(product_id_str)
        self._save_json_file("products.json", self.products)
        return product

    def batch_update_products(self, batch_data: dict) -> dict:
        """Batch update products"""
        results = {'create': [], 'update': [], 'delete': []}
        
        # Create
        for product_data in batch_data.get('create', []):
            try:
                product = self.create_product(product_data)
                results['create'].append(product)
            except Exception as e:
                results['create'].append({'error': str(e)})
        
        # Update
        for product_data in batch_data.get('update', []):
            try:
                product_id = product_data.pop('id')
                product = self.update_product(product_id, product_data)
                results['update'].append(product)
            except Exception as e:
                results['update'].append({'error': str(e)})
        
        # Delete
        for product_id in batch_data.get('delete', []):
            try:
                product = self.delete_product(product_id, force=True)
                results['delete'].append(product)
            except Exception as e:
                results['delete'].append({'error': str(e)})
        
        return results

    def list_variations(self, product_id: int, per_page: int = 10, page: int = 1) -> List[dict]:
        """List product variations"""
        all_variations = [v for v in self.variations.values() if v.get('product_id') == product_id]
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        return all_variations[start_idx:end_idx]

    def list_categories(self, filters: dict = None) -> List[dict]:
        """List product categories"""
        filters = filters or {}
        categories = list(self.categories.values())
        
        if filters.get('search'):
            search_term = filters['search'].lower()
            categories = [c for c in categories if search_term in c.get('name', '').lower()]
        
        if filters.get('parent') is not None:
            parent_id = int(filters['parent'])
            categories = [c for c in categories if c.get('parent') == parent_id]
        
        if filters.get('hideEmpty'):
            categories = [c for c in categories if c.get('count', 0) > 0]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return categories[start_idx:end_idx]

    def create_category(self, category_data: dict) -> dict:
        """Create a product category"""
        category_id = self._generate_id(self.categories)
        category = {
            'id': category_id,
            'count': 0,
            'parent': 0,
            'display': 'default',
            **category_data
        }
        self.categories[str(category_id)] = category
        self._save_json_file("categories.json", self.categories)
        return category

    def list_tags(self, filters: dict = None) -> List[dict]:
        """List product tags"""
        filters = filters or {}
        tags = list(self.tags.values())
        
        if filters.get('search'):
            search_term = filters['search'].lower()
            tags = [t for t in tags if search_term in t.get('name', '').lower()]
        
        if filters.get('hideEmpty'):
            tags = [t for t in tags if t.get('count', 0) > 0]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return tags[start_idx:end_idx]

    def list_reviews(self, filters: dict = None) -> List[dict]:
        """List product reviews"""
        filters = filters or {}
        reviews = list(self.reviews.values())
        
        if filters.get('productId'):
            product_id = int(filters['productId'])
            reviews = [r for r in reviews if r.get('product_id') == product_id]
        
        if filters.get('status') and filters['status'] != 'all':
            reviews = [r for r in reviews if r.get('status') == filters['status']]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return reviews[start_idx:end_idx]

    # ==================== Order Methods ====================
    
    def list_orders(self, filters: dict = None) -> List[dict]:
        """List orders with optional filters"""
        filters = filters or {}
        orders = list(self.orders.values())
        
        # Status filter
        if filters.get('status'):
            status_list = filters['status'] if isinstance(filters['status'], list) else [filters['status']]
            orders = [o for o in orders if o.get('status') in status_list]
        
        # Customer filter
        if filters.get('customer'):
            customer_id = int(filters['customer'])
            orders = [o for o in orders if o.get('customer_id') == customer_id]
        
        # Product filter
        if filters.get('product'):
            product_id = int(filters['product'])
            orders = [o for o in orders if any(
                item.get('product_id') == product_id for item in o.get('line_items', [])
            )]
        
        # Date filters
        if filters.get('dateAfter'):
            orders = [o for o in orders if o.get('date_created', '') >= filters['dateAfter']]
        
        if filters.get('dateBefore'):
            orders = [o for o in orders if o.get('date_created', '') <= filters['dateBefore']]
        
        # Sorting
        orderby = filters.get('orderby', 'date')
        order = filters.get('order', 'desc')
        
        if orderby == 'date':
            orders.sort(key=lambda x: x.get('date_created', ''), reverse=(order == 'desc'))
        elif orderby == 'id':
            orders.sort(key=lambda x: x.get('id', 0), reverse=(order == 'desc'))
        
        # Pagination
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return orders[start_idx:end_idx]

    def get_order(self, order_id: int) -> Optional[dict]:
        """Get a specific order"""
        return self.orders.get(str(order_id))

    def create_order(self, order_data: dict) -> dict:
        """Create a new order"""
        order_id = self._generate_id(self.orders)
        
        # Calculate totals
        line_items = order_data.get('line_items', [])
        total = sum(item.get('quantity', 0) * float(item.get('price', 0)) for item in line_items)
        
        order = {
            'id': order_id,
            'number': str(order_id),
            'status': 'pending',
            'date_created': self._get_timestamp(),
            'date_modified': self._get_timestamp(),
            'total': str(total),
            'subtotal': str(total),
            'discount_total': '0.00',
            'discount_tax': '0.00',
            'shipping_total': '0.00',
            'shipping_tax': '0.00',
            'cart_tax': '0.00',
            'total_tax': '0.00',
            'currency': 'USD',
            'line_items': [],
            'shipping_lines': [],
            'tax_lines': [],
            'fee_lines': [],
            'coupon_lines': [],
            'refunds': [],
            **order_data
        }
        
        self.orders[str(order_id)] = order
        self._save_json_file("orders.json", self.orders)
        return order

    def update_order(self, order_id: int, order_data: dict) -> dict:
        """Update an order"""
        order_id_str = str(order_id)
        if order_id_str not in self.orders:
            raise ValueError(f"Order {order_id} not found")
        
        order = self.orders[order_id_str]
        order.update(order_data)
        order['date_modified'] = self._get_timestamp()
        
        self._save_json_file("orders.json", self.orders)
        return order

    def delete_order(self, order_id: int, force: bool = False) -> dict:
        """Delete an order"""
        order_id_str = str(order_id)
        if order_id_str not in self.orders:
            raise ValueError(f"Order {order_id} not found")
        
        order = self.orders.pop(order_id_str)
        self._save_json_file("orders.json", self.orders)
        return order

    def batch_update_orders(self, batch_data: dict) -> dict:
        """Batch update orders"""
        results = {'create': [], 'update': [], 'delete': []}
        
        for order_data in batch_data.get('create', []):
            try:
                order = self.create_order(order_data)
                results['create'].append(order)
            except Exception as e:
                results['create'].append({'error': str(e)})
        
        for order_data in batch_data.get('update', []):
            try:
                order_id = order_data.pop('id')
                order = self.update_order(order_id, order_data)
                results['update'].append(order)
            except Exception as e:
                results['update'].append({'error': str(e)})
        
        for order_id in batch_data.get('delete', []):
            try:
                order = self.delete_order(order_id, force=True)
                results['delete'].append(order)
            except Exception as e:
                results['delete'].append({'error': str(e)})
        
        return results

    def create_order_note(self, order_id: int, note_data: dict) -> dict:
        """Add a note to an order"""
        order_id_str = str(order_id)
        if order_id_str not in self.orders:
            raise ValueError(f"Order {order_id} not found")
        
        note_id = self._generate_id(self.order_notes)
        note = {
            'id': note_id,
            'order_id': order_id,
            'date_created': self._get_timestamp(),
            'customer_note': False,
            **note_data
        }
        
        self.order_notes[str(note_id)] = note
        self._save_json_file("order_notes.json", self.order_notes)
        return note

    def create_refund(self, order_id: int, refund_data: dict) -> dict:
        """Create a refund for an order"""
        order_id_str = str(order_id)
        if order_id_str not in self.orders:
            raise ValueError(f"Order {order_id} not found")
        
        refund_id = self._generate_id(self.refunds)
        refund = {
            'id': refund_id,
            'order_id': order_id,
            'date_created': self._get_timestamp(),
            'amount': '0.00',
            'reason': '',
            **refund_data
        }
        
        self.refunds[str(refund_id)] = refund
        self._save_json_file("refunds.json", self.refunds)
        
        # Add refund to order
        order = self.orders[order_id_str]
        if 'refunds' not in order:
            order['refunds'] = []
        order['refunds'].append({'id': refund_id, 'total': refund['amount']})
        self._save_json_file("orders.json", self.orders)
        
        return refund

    # ==================== Customer Methods ====================
    
    def list_customers(self, filters: dict = None) -> List[dict]:
        """List customers with optional filters"""
        filters = filters or {}
        customers = list(self.customers.values())
        
        if filters.get('search'):
            search_term = filters['search'].lower()
            customers = [c for c in customers if 
                search_term in c.get('email', '').lower() or
                search_term in c.get('first_name', '').lower() or
                search_term in c.get('last_name', '').lower()
            ]
        
        if filters.get('email'):
            customers = [c for c in customers if c.get('email') == filters['email']]
        
        if filters.get('role') and filters['role'] != 'all':
            customers = [c for c in customers if c.get('role') == filters['role']]
        
        # Sorting
        orderby = filters.get('orderby', 'id')
        order = filters.get('order', 'desc')
        
        if orderby == 'id':
            customers.sort(key=lambda x: x.get('id', 0), reverse=(order == 'desc'))
        elif orderby == 'name':
            customers.sort(key=lambda x: f"{x.get('first_name', '')} {x.get('last_name', '')}", reverse=(order == 'desc'))
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return customers[start_idx:end_idx]

    def get_customer(self, customer_id: int) -> Optional[dict]:
        """Get a specific customer"""
        return self.customers.get(str(customer_id))

    def create_customer(self, customer_data: dict) -> dict:
        """Create a new customer"""
        customer_id = self._generate_id(self.customers)
        customer = {
            'id': customer_id,
            'date_created': self._get_timestamp(),
            'date_modified': self._get_timestamp(),
            'role': 'customer',
            'billing': {},
            'shipping': {},
            'meta_data': [],
            **customer_data
        }
        
        self.customers[str(customer_id)] = customer
        self._save_json_file("customers.json", self.customers)
        return customer

    def update_customer(self, customer_id: int, customer_data: dict) -> dict:
        """Update a customer"""
        customer_id_str = str(customer_id)
        if customer_id_str not in self.customers:
            raise ValueError(f"Customer {customer_id} not found")
        
        customer = self.customers[customer_id_str]
        customer.update(customer_data)
        customer['date_modified'] = self._get_timestamp()
        
        self._save_json_file("customers.json", self.customers)
        return customer

    # ==================== Coupon Methods ====================
    
    def list_coupons(self, filters: dict = None) -> List[dict]:
        """List coupons with optional filters"""
        filters = filters or {}
        coupons = list(self.coupons.values())
        
        if filters.get('search'):
            search_term = filters['search'].lower()
            coupons = [c for c in coupons if search_term in c.get('code', '').lower()]
        
        if filters.get('code'):
            coupons = [c for c in coupons if c.get('code') == filters['code']]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return coupons[start_idx:end_idx]

    def get_coupon(self, coupon_id: int) -> Optional[dict]:
        """Get a specific coupon"""
        return self.coupons.get(str(coupon_id))

    def create_coupon(self, coupon_data: dict) -> dict:
        """Create a new coupon"""
        coupon_id = self._generate_id(self.coupons)
        coupon = {
            'id': coupon_id,
            'date_created': self._get_timestamp(),
            'date_modified': self._get_timestamp(),
            'discount_type': 'percent',
            'amount': '0',
            'individual_use': False,
            'product_ids': [],
            'excluded_product_ids': [],
            'usage_limit': None,
            'usage_limit_per_user': None,
            'limit_usage_to_x_items': None,
            'free_shipping': False,
            'exclude_sale_items': False,
            'usage_count': 0,
            **coupon_data
        }
        
        self.coupons[str(coupon_id)] = coupon
        self._save_json_file("coupons.json", self.coupons)
        return coupon

    def update_coupon(self, coupon_id: int, coupon_data: dict) -> dict:
        """Update a coupon"""
        coupon_id_str = str(coupon_id)
        if coupon_id_str not in self.coupons:
            raise ValueError(f"Coupon {coupon_id} not found")
        
        coupon = self.coupons[coupon_id_str]
        coupon.update(coupon_data)
        coupon['date_modified'] = self._get_timestamp()
        
        self._save_json_file("coupons.json", self.coupons)
        return coupon

    def delete_coupon(self, coupon_id: int, force: bool = True) -> dict:
        """Delete a coupon"""
        coupon_id_str = str(coupon_id)
        if coupon_id_str not in self.coupons:
            raise ValueError(f"Coupon {coupon_id} not found")
        
        coupon = self.coupons.pop(coupon_id_str)
        self._save_json_file("coupons.json", self.coupons)
        return coupon

    # ==================== Shipping Methods ====================
    
    def list_shipping_zones(self) -> List[dict]:
        """List shipping zones"""
        return list(self.shipping_zones.values())

    def get_shipping_zone(self, zone_id: int) -> Optional[dict]:
        """Get a shipping zone"""
        return self.shipping_zones.get(str(zone_id))

    def create_shipping_zone(self, zone_data: dict) -> dict:
        """Create a shipping zone"""
        zone_id = self._generate_id(self.shipping_zones)
        zone = {
            'id': zone_id,
            'order': 0,
            **zone_data
        }
        
        self.shipping_zones[str(zone_id)] = zone
        self._save_json_file("shipping_zones.json", self.shipping_zones)
        return zone

    def update_shipping_zone(self, zone_id: int, zone_data: dict) -> dict:
        """Update a shipping zone"""
        zone_id_str = str(zone_id)
        if zone_id_str not in self.shipping_zones:
            raise ValueError(f"Shipping zone {zone_id} not found")
        
        zone = self.shipping_zones[zone_id_str]
        zone.update(zone_data)
        
        self._save_json_file("shipping_zones.json", self.shipping_zones)
        return zone

    def list_shipping_zone_methods(self, zone_id: int) -> List[dict]:
        """List methods for a shipping zone"""
        return [m for m in self.shipping_methods.values() if m.get('zone_id') == zone_id]

    def create_shipping_zone_method(self, zone_id: int, method_data: dict) -> dict:
        """Add a method to a shipping zone"""
        method_id = self._generate_id(self.shipping_methods)
        method = {
            'id': method_id,
            'zone_id': zone_id,
            'enabled': True,
            'settings': {},
            **method_data
        }
        
        self.shipping_methods[str(method_id)] = method
        self._save_json_file("shipping_methods.json", self.shipping_methods)
        return method

    # ==================== Tax Methods ====================
    
    def list_tax_rates(self, filters: dict = None) -> List[dict]:
        """List tax rates"""
        filters = filters or {}
        tax_rates = list(self.tax_rates.values())
        
        if filters.get('taxClass'):
            tax_rates = [t for t in tax_rates if t.get('class') == filters['taxClass']]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return tax_rates[start_idx:end_idx]

    def get_tax_rate(self, rate_id: int) -> Optional[dict]:
        """Get a tax rate"""
        return self.tax_rates.get(str(rate_id))

    def create_tax_rate(self, rate_data: dict) -> dict:
        """Create a tax rate"""
        rate_id = self._generate_id(self.tax_rates)
        rate = {
            'id': rate_id,
            'priority': 1,
            'compound': False,
            'shipping': True,
            'class': 'standard',
            **rate_data
        }
        
        self.tax_rates[str(rate_id)] = rate
        self._save_json_file("tax_rates.json", self.tax_rates)
        return rate

    def list_tax_classes(self) -> List[dict]:
        """List tax classes"""
        return list(self.tax_classes.values())

    # ==================== Report Methods ====================
    
    def get_sales_report(self, filters: dict = None) -> dict:
        """Get sales report"""
        filters = filters or {}
        orders = [o for o in self.orders.values() if o.get('status') in ['completed', 'processing']]
        
        # Apply date filters
        if filters.get('dateMin'):
            orders = [o for o in orders if o.get('date_created', '') >= filters['dateMin']]
        if filters.get('dateMax'):
            orders = [o for o in orders if o.get('date_created', '') <= filters['dateMax']]
        
        total_sales = sum(float(o.get('total', 0)) for o in orders)
        total_orders = len(orders)
        
        return {
            'total_sales': str(total_sales),
            'total_orders': total_orders,
            'average_order_value': str(total_sales / total_orders if total_orders > 0 else 0)
        }

    def get_top_sellers_report(self, filters: dict = None) -> List[dict]:
        """Get top sellers report"""
        filters = filters or {}
        orders = [o for o in self.orders.values() if o.get('status') in ['completed', 'processing']]
        
        # Apply date filters
        if filters.get('dateMin'):
            orders = [o for o in orders if o.get('date_created', '') >= filters['dateMin']]
        if filters.get('dateMax'):
            orders = [o for o in orders if o.get('date_created', '') <= filters['dateMax']]
        
        # Count product sales
        product_sales = {}
        for order in orders:
            for item in order.get('line_items', []):
                product_id = item.get('product_id')
                if product_id:
                    if product_id not in product_sales:
                        product_sales[product_id] = {
                            'product_id': product_id,
                            'name': item.get('name', ''),
                            'quantity': 0
                        }
                    product_sales[product_id]['quantity'] += item.get('quantity', 0)
        
        # Sort by quantity
        top_sellers = sorted(product_sales.values(), key=lambda x: x['quantity'], reverse=True)
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return top_sellers[start_idx:end_idx]

    def get_customers_report(self, filters: dict = None) -> dict:
        """Get customers report"""
        customers = list(self.customers.values())
        orders = list(self.orders.values())
        
        return {
            'total_customers': len(customers),
            'total_orders': len(orders),
            'average_orders_per_customer': len(orders) / len(customers) if customers else 0
        }

    def get_orders_report(self, filters: dict = None) -> dict:
        """Get orders report"""
        filters = filters or {}
        orders = list(self.orders.values())
        
        # Apply date filters
        if filters.get('dateMin'):
            orders = [o for o in orders if o.get('date_created', '') >= filters['dateMin']]
        if filters.get('dateMax'):
            orders = [o for o in orders if o.get('date_created', '') <= filters['dateMax']]
        
        status_counts = {}
        for order in orders:
            status = order.get('status', 'unknown')
            status_counts[status] = status_counts.get(status, 0) + 1
        
        return {
            'total_orders': len(orders),
            'by_status': status_counts
        }

    def get_products_report(self, filters: dict = None) -> List[dict]:
        """Get products report"""
        filters = filters or {}
        products = list(self.products.values())
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return products[start_idx:end_idx]

    def get_stock_report(self, filters: dict = None) -> List[dict]:
        """Get stock report"""
        filters = filters or {}
        products = [p for p in self.products.values() if p.get('manage_stock', False)]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return products[start_idx:end_idx]

    def get_low_stock_report(self, filters: dict = None) -> List[dict]:
        """Get low stock report"""
        filters = filters or {}
        products = [p for p in self.products.values() 
                   if p.get('manage_stock', False) and p.get('stock_quantity', 0) < 10]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return products[start_idx:end_idx]

    # ==================== System Methods ====================
    
    def get_system_status(self) -> dict:
        """Get system status"""
        return {
            'environment': {
                'version': '1.0.0',
                'database': 'JSON files'
            },
            'database': {
                'products': len(self.products),
                'orders': len(self.orders),
                'customers': len(self.customers),
                'coupons': len(self.coupons)
            }
        }

    def list_system_tools(self) -> List[dict]:
        """List system tools"""
        return list(self.system_tools.values())

    def run_system_tool(self, tool_id: str) -> dict:
        """Run a system tool"""
        return {
            'success': True,
            'message': f'Tool {tool_id} executed successfully'
        }

    def list_settings_groups(self) -> List[dict]:
        """List settings groups"""
        return [
            {'id': 'general', 'label': 'General', 'description': 'General settings'},
            {'id': 'products', 'label': 'Products', 'description': 'Product settings'},
            {'id': 'tax', 'label': 'Tax', 'description': 'Tax settings'},
            {'id': 'shipping', 'label': 'Shipping', 'description': 'Shipping settings'},
            {'id': 'checkout', 'label': 'Checkout', 'description': 'Checkout settings'},
        ]

    def get_settings_group(self, group_id: str) -> List[dict]:
        """Get settings for a group"""
        return self.settings.get(group_id, [])

    def list_payment_gateways(self) -> List[dict]:
        """List payment gateways"""
        return list(self.payment_gateways.values())

    def get_payment_gateway(self, gateway_id: str) -> Optional[dict]:
        """Get a payment gateway"""
        return self.payment_gateways.get(gateway_id)

    def update_payment_gateway(self, gateway_id: str, gateway_data: dict) -> dict:
        """Update a payment gateway"""
        if gateway_id not in self.payment_gateways:
            raise ValueError(f"Payment gateway {gateway_id} not found")
        
        gateway = self.payment_gateways[gateway_id]
        gateway.update(gateway_data)
        
        self._save_json_file("payment_gateways.json", self.payment_gateways)
        return gateway

    def list_webhooks(self, filters: dict = None) -> List[dict]:
        """List webhooks"""
        filters = filters or {}
        webhooks = list(self.webhooks.values())
        
        if filters.get('status'):
            webhooks = [w for w in webhooks if w.get('status') == filters['status']]
        
        per_page = filters.get('perPage', 10)
        page = filters.get('page', 1)
        start_idx = (page - 1) * per_page
        end_idx = start_idx + per_page
        
        return webhooks[start_idx:end_idx]

    def create_webhook(self, webhook_data: dict) -> dict:
        """Create a webhook"""
        webhook_id = self._generate_id(self.webhooks)
        webhook = {
            'id': webhook_id,
            'date_created': self._get_timestamp(),
            'date_modified': self._get_timestamp(),
            'status': 'active',
            **webhook_data
        }
        
        self.webhooks[str(webhook_id)] = webhook
        self._save_json_file("webhooks.json", self.webhooks)
        return webhook
