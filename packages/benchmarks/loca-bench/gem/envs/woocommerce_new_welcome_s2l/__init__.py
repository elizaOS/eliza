"""
WooCommerce New Welcome S2L Environment

This environment simulates a new customer onboarding scenario where the agent needs to:
1. Identify first-time customers from WooCommerce orders (within past 7 days)
2. Sync new customer information to company CRM (BigQuery)
3. Send personalized welcome emails to new customers

The task requires the agent to analyze order data, perform customer identification,
sync to cloud database, and execute email campaigns.
"""

from .woocommerce_new_welcome_s2l import WoocommerceNewWelcomeS2LEnv

__all__ = ["WoocommerceNewWelcomeS2LEnv"]

