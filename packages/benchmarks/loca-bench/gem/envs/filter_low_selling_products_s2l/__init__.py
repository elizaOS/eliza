"""
Filter Low Selling Products S2L Environment

This environment simulates an e-commerce product management scenario where the agent needs to:
1. Identify low-selling products based on inventory age and sales data
2. Move them to a "Clearance" category in WooCommerce
3. Send promotional emails to subscribers

The task requires the agent to analyze sales data, perform product categorization,
and execute email campaigns.
"""

from .filter_low_selling_products_s2l import FilterLowSellingProductsS2LEnv

__all__ = ["FilterLowSellingProductsS2LEnv"]

