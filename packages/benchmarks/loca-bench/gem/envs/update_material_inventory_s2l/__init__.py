"""Update Material Inventory S2L Environment.

This environment simulates a material inventory management scenario where an agent
needs to read BOM and material inventory from Google Sheets, calculate maximum
producible quantities, and update WooCommerce product stock accordingly.
"""

from .update_material_inventory_s2l import UpdateMaterialInventoryS2LEnv

__all__ = ["UpdateMaterialInventoryS2LEnv"]


