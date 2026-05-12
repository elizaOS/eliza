#!/usr/bin/env python3
"""
Low Selling Product Filter - Task-specific functionality for filtering low-selling products
Uses the general WooCommerceClient from utils.app_specific.woocommerce
"""

import json
import time
from datetime import datetime
from typing import Dict, List, Optional


class LowSellingProductFilter:
    """Low selling product filter for WooCommerce stores"""

    def __init__(self, wc_client):
        """
        Initialize filter with WooCommerce client

        Args:
            wc_client: WooCommerceClient instance from utils.app_specific.woocommerce
        """
        self.wc_client = wc_client
        self.outlet_category_id = None

    def analyze_products(self, days_in_stock_threshold: int = 90,
                        sales_30_days_threshold: int = 10) -> Dict:
        """
        Analyze products and filter low-selling ones

        Args:
            days_in_stock_threshold: Days in stock threshold (default 90 days)
            sales_30_days_threshold: 30-day sales threshold (default 10 units)

        Returns:
            Dictionary containing analysis results
        """
        print(f"🔍 Starting product analysis...")
        print(f"   Filter criteria: Days in stock > {days_in_stock_threshold} days AND 30-day sales < {sales_30_days_threshold} units")

        # Get all products
        all_products = self.wc_client.get_all_products()

        low_selling_products = []
        normal_products = []
        current_date = datetime.now()

        for product in all_products:
            try:
                # Get product creation date
                date_created_str = product.get('date_created', '')
                if not date_created_str:
                    continue

                # Parse creation date
                date_created = datetime.fromisoformat(date_created_str.replace('Z', '+00:00'))
                days_in_stock = (current_date - date_created.replace(tzinfo=None)).days

                # Get 30-day sales data (from meta_data)
                sales_30_days = 0
                meta_data = product.get('meta_data', [])
                for meta in meta_data:
                    if meta.get('key') in ['sales_last_30_days', '_sales_last_30_days', 'sales_30_days']:
                        try:
                            sales_30_days = int(meta.get('value', 0))
                            break
                        except (ValueError, TypeError):
                            continue

                # If not found in meta_data, try to estimate from total sales
                if sales_30_days == 0:
                    total_sales = product.get('total_sales', 0)
                    if total_sales > 0:
                        # Simple estimation: assume sales are evenly distributed
                        sales_30_days = max(1, int(total_sales * 30 / max(days_in_stock, 30)))

                product_info = {
                    'id': product.get('id'),
                    'name': product.get('name', ''),
                    'sku': product.get('sku', ''),
                    'price': product.get('price', '0'),
                    'sale_price': product.get('sale_price', product.get('price', '0')),
                    'stock_quantity': product.get('stock_quantity', 0),
                    'stock_status': product.get('stock_status', ''),
                    'date_created': date_created_str,
                    'days_in_stock': days_in_stock,
                    'sales_30_days': sales_30_days,
                    'total_sales': product.get('total_sales', 0),
                    'categories': [cat.get('name', '') for cat in product.get('categories', [])],
                    'status': product.get('status', '')
                }

                # Determine if it's a low-selling product
                if (days_in_stock > days_in_stock_threshold and
                    sales_30_days < sales_30_days_threshold):
                    low_selling_products.append(product_info)
                else:
                    normal_products.append(product_info)

            except Exception as e:
                print(f"⚠️ Error processing product {product.get('name', 'Unknown')}: {e}")
                continue

        analysis_result = {
            'total_products': len(all_products),
            'low_selling_products': low_selling_products,
            'normal_products': normal_products,
            'low_selling_count': len(low_selling_products),
            'normal_count': len(normal_products),
            'filter_criteria': {
                'days_in_stock_threshold': days_in_stock_threshold,
                'sales_30_days_threshold': sales_30_days_threshold
            },
            'analysis_date': current_date.isoformat()
        }

        print(f"📊 Analysis complete:")
        print(f"   Total products: {analysis_result['total_products']}")
        print(f"   Low-selling products: {analysis_result['low_selling_count']}")
        print(f"   Normal products: {analysis_result['normal_count']}")

        return analysis_result

    def ensure_outlet_category(self) -> bool:
        """Ensure "Outlet/Clearance" category exists"""
        print("🏷️ Checking Outlet/Clearance category...")

        # Get existing categories
        success, categories = self.wc_client.get_product_categories()
        if not success:
            print(f"❌ Failed to get categories: {categories}")
            return False

        # Look for existing Outlet category
        outlet_names = ["Outlet", "Clearance", "Outlet/Clearance"]

        for category in categories:
            if category.get('name', '') in outlet_names:
                self.outlet_category_id = category.get('id')
                print(f"✅ Found existing category: {category.get('name')} (ID: {self.outlet_category_id})")
                return True

        # If not exists, create new category
        category_data = {
            "name": "Outlet/Clearance",
            "description": "Low-selling products clearance promotion category",
            "slug": "outlet-clearance"
        }

        success, new_category = self.wc_client.create_category(category_data)
        if success:
            self.outlet_category_id = new_category.get('id')
            print(f"✅ Created new category: Outlet/Clearance (ID: {self.outlet_category_id})")
            return True
        else:
            print(f"❌ Failed to create category: {new_category}")
            return False

    def move_products_to_outlet(self, low_selling_products: List[Dict]) -> Dict:
        """
        Move low-selling products to Outlet category

        Args:
            low_selling_products: List of low-selling products

        Returns:
            Results of the move operation
        """
        if not self.outlet_category_id:
            if not self.ensure_outlet_category():
                return {"success": False, "error": "Cannot create or find Outlet category"}

        print(f"📦 Starting to move {len(low_selling_products)} products to Outlet category...")

        # Prepare batch update data
        updates = []
        for product in low_selling_products:
            product_id = product.get('id')
            if not product_id:
                continue

            # Get existing categories, add Outlet category
            existing_categories = product.get('categories', [])
            category_ids = [cat.get('id') for cat in existing_categories if cat.get('id')]

            # Add Outlet category ID (if not already present)
            if self.outlet_category_id not in category_ids:
                category_ids.append(self.outlet_category_id)

            update_data = {
                "id": product_id,
                "categories": [{"id": cat_id} for cat_id in category_ids]
            }
            updates.append(update_data)

        # Batch update (WooCommerce API limit, process in batches)
        batch_size = 20
        successful_moves = []
        failed_moves = []

        for i in range(0, len(updates), batch_size):
            batch = updates[i:i + batch_size]
            success, result = self.wc_client.batch_update_products(batch)

            if success:
                # Check batch operation results
                updated_products = result.get('update', [])
                for updated_product in updated_products:
                    if updated_product.get('id'):
                        successful_moves.append(updated_product.get('id'))
                    else:
                        failed_moves.append(updated_product)
            else:
                print(f"❌ Batch update failed: {result}")
                failed_moves.extend(batch)

            # Avoid API limits
            time.sleep(1)

        move_result = {
            "success": len(failed_moves) == 0,
            "total_products": len(low_selling_products),
            "successful_moves": len(successful_moves),
            "failed_moves": len(failed_moves),
            "outlet_category_id": self.outlet_category_id,
            "moved_product_ids": successful_moves,
            "failed_product_data": failed_moves
        }

        print(f"📊 Move results:")
        print(f"   Successfully moved: {move_result['successful_moves']} products")
        print(f"   Failed to move: {move_result['failed_moves']} products")

        return move_result

    def generate_report(self, analysis_result: Dict, move_result: Dict = None) -> str:
        """
        Generate analysis report

        Args:
            analysis_result: Product analysis results
            move_result: Move operation results (optional)

        Returns:
            Report content string
        """
        report_lines = []
        report_lines.append("# Low-Selling Products Filter Report")
        report_lines.append("")
        report_lines.append(f"**Analysis Time**: {analysis_result.get('analysis_date', '')}")
        report_lines.append("")

        # Filter criteria
        criteria = analysis_result.get('filter_criteria', {})
        report_lines.append("## Filter Criteria")
        report_lines.append(f"- Days in stock threshold: > {criteria.get('days_in_stock_threshold', 90)} days")
        report_lines.append(f"- 30-day sales threshold: < {criteria.get('sales_30_days_threshold', 10)} units")
        report_lines.append("")

        # Overall statistics
        report_lines.append("## Analysis Results")
        report_lines.append(f"- Total products: {analysis_result.get('total_products', 0)}")
        report_lines.append(f"- Low-selling products: {analysis_result.get('low_selling_count', 0)}")
        report_lines.append(f"- Normal selling products: {analysis_result.get('normal_count', 0)}")
        report_lines.append("")

        # Low-selling products details
        low_selling_products = analysis_result.get('low_selling_products', [])
        if low_selling_products:
            report_lines.append("## Low-Selling Products Details")
            report_lines.append("")
            report_lines.append("| Product Name | SKU | Price | Sale Price | Stock | Days in Stock | 30-Day Sales | Total Sales |")
            report_lines.append("|--------------|-----|-------|------------|-------|---------------|--------------|-------------|")

            for product in low_selling_products[:20]:  # Only show first 20
                name = product.get('name', '')[:30]  # Limit length
                sku = product.get('sku', '')
                price = product.get('price', '0')
                sale_price = product.get('sale_price', price)
                stock = product.get('stock_quantity', 0)
                days = product.get('days_in_stock', 0)
                sales_30 = product.get('sales_30_days', 0)
                total_sales = product.get('total_sales', 0)

                report_lines.append(f"| {name} | {sku} | ${price} | ${sale_price} | {stock} | {days} | {sales_30} | {total_sales} |")

            if len(low_selling_products) > 20:
                report_lines.append(f"| ... | ... | ... | ... | ... | ... | ... | ... |")
                report_lines.append(f"*(Showing first 20 out of {len(low_selling_products)} low-selling products)*")

            report_lines.append("")

        # Move operation results
        if move_result:
            report_lines.append("## Category Move Results")
            report_lines.append(f"- Successfully moved to Outlet category: {move_result.get('successful_moves', 0)} products")
            report_lines.append(f"- Failed to move: {move_result.get('failed_moves', 0)} products")
            report_lines.append(f"- Outlet category ID: {move_result.get('outlet_category_id', 'N/A')}")
            report_lines.append("")

        report_lines.append("---")
        report_lines.append("*Report generated by Low-Selling Products Filter System*")

        return "\n".join(report_lines)