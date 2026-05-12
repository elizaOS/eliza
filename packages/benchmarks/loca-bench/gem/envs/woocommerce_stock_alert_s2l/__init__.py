"""WooCommerce Stock Alert S2L Environment.

This environment simulates a WooCommerce inventory monitoring scenario where
the agent needs to:
1. Monitor product inventory levels in WooCommerce
2. Identify products with stock below safety threshold
3. Update Google Sheets with low-stock products
4. Send email alerts to purchasing manager

The environment supports configurable difficulty levels and parallel execution.
"""

from gem.envs.woocommerce_stock_alert_s2l.woocommerce_stock_alert_s2l import (
    WoocommerceStockAlertS2LEnv,
)

__all__ = [
    "WoocommerceStockAlertS2LEnv",
]


