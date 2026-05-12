#!/usr/bin/env python3
"""
WooCommerce Client - WooCommerce connection and product management for stock alert tasks
"""

import requests
from requests.auth import HTTPBasicAuth
import json
import logging
from typing import Dict, List, Optional, Tuple
from datetime import datetime

class WooCommerceClient:
    """WooCommerce API Client"""

    def __init__(self, site_url: str, consumer_key: str, consumer_secret: str):
        """
        Initialize WooCommerce client

        Args:
            site_url: WooCommerce site URL
            consumer_key: API consumer key
            consumer_secret: API consumer secret
        """
        self.site_url = site_url.rstrip('/')
        self.api_base = f"{self.site_url}/wp-json/wc/v3"
        self.auth = HTTPBasicAuth(consumer_key, consumer_secret)
        self.session = requests.Session()
        self.session.auth = self.auth
        self.logger = self._setup_logging()
    
    def _setup_logging(self):
        """Set up logging"""
        logging.basicConfig(level=logging.INFO)
        return logging.getLogger(__name__)

    def test_connection(self) -> bool:
        """Test API connection"""
        try:
            response = self.session.get(f"{self.api_base}/system_status")
            return response.status_code == 200
        except Exception as e:
            self.logger.error(f"Connection test failed: {e}")
            return False
    
    def create_product(self, product_data: Dict) -> Tuple[bool, Dict]:
        """
        Create a product

        Args:
            product_data: Product data

        Returns:
            (success flag, result data)
        """
        try:
            response = self.session.post(
                f"{self.api_base}/products",
                json=product_data,
                timeout=30
            )
            
            if response.status_code == 201:
                return True, response.json()
            else:
                error_msg = f"HTTP {response.status_code}: {response.text}"
                return False, error_msg
                
        except Exception as e:
            return False, str(e)
    
    def update_product(self, product_id: str, update_data: Dict) -> Tuple[bool, Dict]:
        """
        Update a product

        Args:
            product_id: Product ID
            update_data: Update data

        Returns:
            (success flag, result data)
        """
        try:
            response = self.session.put(
                f"{self.api_base}/products/{product_id}",
                json=update_data,
                timeout=30
            )
            
            if response.status_code == 200:
                return True, response.json()
            else:
                error_msg = f"HTTP {response.status_code}: {response.text}"
                return False, error_msg
                
        except Exception as e:
            return False, str(e)
    
    def get_product(self, product_id: str) -> Tuple[bool, Dict]:
        """
        Get product information

        Args:
            product_id: Product ID

        Returns:
            (success flag, product data)
        """
        try:
            response = self.session.get(f"{self.api_base}/products/{product_id}")
            
            if response.status_code == 200:
                return True, response.json()
            else:
                error_msg = f"HTTP {response.status_code}: {response.text}"
                return False, error_msg
                
        except Exception as e:
            return False, str(e)
    
    def get_all_products(self) -> List[Dict]:
        """Get all products"""
        try:
            all_products = []
            page = 1
            per_page = 100
            
            while True:
                response = self.session.get(
                    f"{self.api_base}/products",
                    params={
                        'page': page,
                        'per_page': per_page,
                        'status': 'any'
                    }
                )
                
                if response.status_code != 200:
                    break
                
                products = response.json()
                if not products:
                    break
                
                all_products.extend(products)

                # Check if there are more pages
                total_pages = int(response.headers.get('X-WP-TotalPages', 1))
                if page >= total_pages:
                    break
                
                page += 1
            
            return all_products
            
        except Exception as e:
            self.logger.error(f"Failed to get product list: {e}")
            return []

    def delete_product(self, product_id: str, force: bool = True) -> Tuple[bool, Dict]:
        """
        Delete a product

        Args:
            product_id: Product ID
            force: Whether to force delete

        Returns:
            (success flag, result data)
        """
        try:
            params = {'force': 'true'} if force else {}
            response = self.session.delete(
                f"{self.api_base}/products/{product_id}",
                params=params
            )
            
            if response.status_code in [200, 204]:
                return True, response.json() if response.text else {}
            else:
                error_msg = f"HTTP {response.status_code}: {response.text}"
                return False, error_msg
                
        except Exception as e:
            return False, str(e)
    
    def clear_all_products(self) -> Tuple[bool, int]:
        """
        Clear all products

        Returns:
            (success flag, number of deleted products)
        """
        try:
            self.logger.info("🧹 Starting to clear all products...")

            # Get all products
            products = self.get_all_products()
            deleted_count = 0

            for product in products:
                product_id = str(product.get('id'))
                product_name = product.get('name', f'ProductID-{product_id}')
                
                success, result = self.delete_product(product_id, force=True)
                if success:
                    deleted_count += 1
                    self.logger.info(f"🗑️ Deleted product: {product_name} (ID: {product_id})")
                else:
                    self.logger.warning(f"⚠️ Failed to delete product: {product_name} - {result}")

            self.logger.info(f"✅ Clearing completed, deleted {deleted_count} products")
            return True, deleted_count

        except Exception as e:
            self.logger.error(f"Failed to clear products: {e}")
            return False, 0
    
    def setup_stock_alert_products(self, products_data: List[Dict]) -> Tuple[bool, List[Dict]]:
        """
        Set up stock alert test products

        Args:
            products_data: List of product data

        Returns:
            (success flag, list of created products)
        """
        try:
            self.logger.info("📦 Starting to set up stock alert test products...")
            created_products = []
            
            for product_info in products_data:
                # Convert to WooCommerce product format
                wc_product = {
                    "name": product_info.get("name"),
                    "sku": product_info.get("sku"),
                    "type": "simple",
                    "regular_price": str(product_info.get("price", 0)),
                    "stock_quantity": product_info.get("stock_quantity", 0),
                    "manage_stock": True,
                    "stock_status": "instock" if product_info.get("stock_quantity", 0) > 0 else "outofstock",
                    "status": "publish",
                    "categories": [
                        {"name": product_info.get("category", "General")}
                    ],
                    "meta_data": [
                        {
                            "key": "stock_threshold",
                            "value": str(product_info.get("stock_threshold", 10))
                        },
                        {
                            "key": "supplier_name", 
                            "value": product_info.get("supplier", {}).get("name", "")
                        },
                        {
                            "key": "supplier_contact",
                            "value": product_info.get("supplier", {}).get("contact", "")
                        },
                        {
                            "key": "supplier_id",
                            "value": product_info.get("supplier", {}).get("supplier_id", "")
                        }
                    ]
                }
                
                success, result = self.create_product(wc_product)
                if success:
                    created_products.append(result)
                    self.logger.info(f"✅ Created product: {product_info.get('name')} (stock: {product_info.get('stock_quantity')}, threshold: {product_info.get('stock_threshold')})")
                else:
                    self.logger.error(f"❌ Failed to create product: {product_info.get('name')} - {result}")

            self.logger.info(f"📊 Setup completed, created {len(created_products)} test products")
            return True, created_products

        except Exception as e:
            self.logger.error(f"Failed to set up products: {e}")
            return False, []
    
    def get_low_stock_products(self) -> List[Dict]:
        """
        Get products with stock below safety threshold

        Returns:
            List of low stock products
        """
        try:
            all_products = self.get_all_products()
            low_stock_products = []
            
            for product in all_products:
                stock_quantity = product.get('stock_quantity', 0)
                
                # Get stock threshold (from meta_data)
                stock_threshold = 10  # Default value
                meta_data = product.get('meta_data', [])
                for meta in meta_data:
                    if meta.get('key') == 'stock_threshold':
                        try:
                            stock_threshold = int(meta.get('value', 10))
                        except (ValueError, TypeError):
                            stock_threshold = 10
                        break

                # Check if below threshold
                if stock_quantity < stock_threshold:
                    low_stock_products.append({
                        'id': product.get('id'),
                        'name': product.get('name'),
                        'sku': product.get('sku'),
                        'stock_quantity': stock_quantity,
                        'stock_threshold': stock_threshold,
                        'supplier_info': self._extract_supplier_info(product.get('meta_data', []))
                    })
            
            self.logger.info(f"🔍 Found {len(low_stock_products)} low stock products")
            return low_stock_products

        except Exception as e:
            self.logger.error(f"Failed to get low stock products: {e}")
            return []

    def _extract_supplier_info(self, meta_data: List[Dict]) -> Dict:
        """Extract supplier information from product meta_data"""
        supplier_info = {}
        for meta in meta_data:
            key = meta.get('key', '')
            value = meta.get('value', '')
            
            if key == 'supplier_name':
                supplier_info['name'] = value
            elif key == 'supplier_contact':
                supplier_info['contact'] = value
            elif key == 'supplier_id':
                supplier_info['supplier_id'] = value
        
        return supplier_info