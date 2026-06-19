from argparse import ArgumentParser
import os
import sys
import json
import shutil
import logging
from pathlib import Path
import asyncio
from datetime import datetime

# Add local paths for imports
current_dir = os.path.dirname(os.path.abspath(__file__))
task_dir = os.path.dirname(current_dir)
sys.path.insert(0, task_dir)
sys.path.insert(0, current_dir)
from gem.utils.filesystem import nfs_safe_rmtree

from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase
from mcp_convert.mcps.woocommerce.init_database import initialize_database as init_woocommerce_db
from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase

# Import order simulator
# Use regular import since current_dir is already in sys.path
# (relative imports don't work when running as standalone script)
try:
    from order_simulator import OrderSimulator  # type: ignore
except ImportError:
    OrderSimulator = None

class WooCommerceDatabaseAdapter:
    """Adapter to make WooCommerceDatabase compatible with OrderSimulator"""
    
    def __init__(self, wc_db: WooCommerceDatabase):
        self.wc_db = wc_db
    
    def get_all_products(self):
        """Get all products - adapter method for OrderSimulator"""
        return self.wc_db.list_products(filters={'perPage': 100})
    
    def create_order(self, order_data: dict):
        """Create order - adapter method for OrderSimulator
        
        Returns:
            tuple: (success: bool, result: dict)
        """
        try:
            result = self.wc_db.create_order(order_data)
            return (True, result)
        except Exception as e:
            return (False, {'error': str(e)})

def setup_google_sheets_local(google_sheet_db_dir: str, task_root: Path, 
                             materials: list, bom: list) -> str:
    """
    Setup Google Sheets using local database
    
    Args:
        google_sheet_db_dir: Google Sheets database directory
        task_root: Task root directory
        materials: List of material dictionaries
        bom: List of BOM entries
        
    Returns:
        spreadsheet_id of the created spreadsheet
    """
    print("\n📊 Setting up Google Sheets (Local Database)...")
    print("=" * 60)
    
    try:
        # Initialize Google Sheet Database
        gs_db = GoogleSheetDatabase(data_dir=google_sheet_db_dir)
        
        # Create a new spreadsheet (only pass title string)
        spreadsheet_result = gs_db.create_spreadsheet("Material Inventory Management")
        spreadsheet_id = spreadsheet_result.get('spreadsheetId') if isinstance(spreadsheet_result, dict) else spreadsheet_result
        print(f"   ✓ Created spreadsheet: {spreadsheet_id}")
        
        # Create BOM sheet
        gs_db.create_sheet(spreadsheet_id, "BOM")
        print(f"   ✓ Created BOM sheet")
        
        # Create Material_Inventory sheet
        gs_db.create_sheet(spreadsheet_id, "Material_Inventory")
        print(f"   ✓ Created Material_Inventory sheet")
        
        # Setup BOM sheet data from generated data
        bom_data = [["Product SKU", "Product Name", "Raw Material ID", "Raw Material Name", "Unit Quantity", "Unit"]]
        for entry in bom:
            bom_data.append([
                entry['product_sku'],
                entry['product_name'],
                entry['material_id'],
                entry['material_name'],
                str(entry['quantity']),
                entry['unit']
            ])
        
        # Update BOM sheet with data
        num_rows = len(bom_data)
        range_notation = f"A1:F{num_rows}"
        gs_db.update_cells(spreadsheet_id, "BOM", range_notation, bom_data)
        print(f"   ✓ Populated BOM sheet with {len(bom_data)} rows")
        
        # Setup Material_Inventory sheet data from generated data
        inventory_data = [["Material ID", "Material Name", "Current Stock", "Unit", "Min Stock", "Supplier"]]
        for material in materials:
            inventory_data.append([
                material['id'],
                material['name_cn'],
                str(material['current_stock']),
                material['unit'],
                str(material['min_stock']),
                material['supplier']
            ])
        
        # Update Material_Inventory sheet with data
        num_rows = len(inventory_data)
        range_notation = f"A1:F{num_rows}"
        gs_db.update_cells(spreadsheet_id, "Material_Inventory", range_notation, inventory_data)
        print(f"   ✓ Populated Material_Inventory sheet with {len(inventory_data)} rows")
        
        print(f"✅ Google Sheets setup completed")
        print(f"   Spreadsheet ID: {spreadsheet_id}")
        
        return spreadsheet_id
        
    except Exception as e:
        print(f"❌ Google Sheets setup failed: {e}")
        import traceback
        traceback.print_exc()
        raise

def setup_logging():
    """Setup logging"""
    logging.basicConfig(level=logging.INFO)
    return logging.getLogger(__name__)


def generate_inventory_data(num_products: int, num_materials: int, 
                           materials_per_product: int, seed: int = 42) -> dict:
    """
    Generate random inventory data (products, materials, BOM)
    
    Args:
        num_products: Number of products to generate
        num_materials: Number of raw materials to generate
        materials_per_product: Average materials per product in BOM
        seed: Random seed
        
    Returns:
        dict with keys: 'products', 'materials', 'bom'
    """
    import random
    import string
    random.seed(seed)
    
    # Product templates
    product_types = [
        ("Chair", "CHAIR", 250.0, 450.0),
        ("Table", "TABLE", 600.0, 1200.0),
        ("Desk", "DESK", 500.0, 900.0),
        ("Cabinet", "CABINET", 700.0, 1400.0),
        ("Shelf", "SHELF", 150.0, 350.0),
        ("Bench", "BENCH", 300.0, 550.0),
        ("Stool", "STOOL", 100.0, 250.0),
        ("Dresser", "DRESSER", 800.0, 1500.0),
        ("Wardrobe", "WARDROBE", 1200.0, 2200.0),
        ("Nightstand", "NIGHTSTAND", 200.0, 400.0),
        ("Bookcase", "BOOKCASE", 400.0, 800.0),
        ("Console", "CONSOLE", 350.0, 650.0),
        ("Ottoman", "OTTOMAN", 180.0, 320.0),
        ("Armchair", "ARMCHAIR", 350.0, 650.0),
        ("Sofa", "SOFA", 1000.0, 2000.0),
    ]
    
    # Material templates (ID, Name_EN, Name_CN, Unit, Base_Stock)
    # Massively increased base stock to allow for many orders (50x+ multiplier from original)
    material_templates = [
        ("WOOD_OAK", "Oak Planks", "Oak Planks", "square meters", 10000.0),
        ("WOOD_PINE", "Pine Planks", "Pine Planks", "square meters", 9000.0),
        ("WOOD_MAPLE", "Maple Planks", "Maple Planks", "square meters", 8000.0),
        ("WOOD_WALNUT", "Walnut Planks", "Walnut Planks", "square meters", 7500.0),
        ("WOOD_CHERRY", "Cherry Planks", "Cherry Planks", "square meters", 8000.0),
        ("WOOD_BIRCH", "Birch Planks", "Birch Planks", "square meters", 9500.0),
        ("SCREW_M6", "M6 Screws", "M6 Screws", "pcs", 50000),
        ("SCREW_M8", "M8 Screws", "M8 Screws", "pcs", 45000),
        ("SCREW_M10", "M10 Screws", "M10 Screws", "pcs", 40000),
        ("NAIL_50MM", "50mm Nails", "50mm Nails", "pcs", 80000),
        ("NAIL_75MM", "75mm Nails", "75mm Nails", "pcs", 70000),
        ("GLUE_WOOD", "Wood Glue", "Wood Glue", "L", 1500.0),
        ("GLUE_STRONG", "Strong Adhesive", "Strong Adhesive", "L", 1300.0),
        ("FINISH_VARNISH", "Clear Varnish", "Clear Varnish", "L", 1800.0),
        ("FINISH_PAINT", "Paint", "Paint", "L", 1600.0),
        ("FINISH_STAIN", "Wood Stain", "Wood Stain", "L", 1500.0),
        ("FINISH_OIL", "Wood Oil", "Wood Oil", "L", 1400.0),
        ("METAL_LEG", "Metal Table Legs", "Metal Table Legs", "pcs", 8000),
        ("METAL_BRACKET", "Metal Brackets", "Metal Brackets", "pcs", 13000),
        ("METAL_HINGE", "Metal Hinges", "Metal Hinges", "pcs", 15000),
        ("METAL_HANDLE", "Metal Handles", "Metal Handles", "pcs", 20000),
        ("FABRIC_COTTON", "Cotton Fabric", "Cotton Fabric", "meters", 5000.0),
        ("FABRIC_LINEN", "Linen Fabric", "Linen Fabric", "meters", 4500.0),
        ("FABRIC_VELVET", "Velvet Fabric", "Velvet Fabric", "meters", 4000.0),
        ("FOAM_CUSHION", "Cushion Foam", "Cushion Foam", "pcs", 6000),
        ("SPRING_COIL", "Coil Springs", "Coil Springs", "pcs", 10000),
        ("GLASS_PANEL", "Glass Panel", "Glass Panel", "pcs", 3000),
        ("MARBLE_TOP", "Marble Top", "Marble Top", "pcs", 1800),
        ("RUBBER_FEET", "Rubber Feet", "Rubber Feet", "pcs", 35000),
        ("PLASTIC_CAP", "Plastic End Caps", "Plastic End Caps", "pcs", 45000),
    ]
    
    # Generate products
    products = []
    selected_product_types = random.sample(product_types, min(num_products, len(product_types)))
    for i, (ptype, prefix, price_min, price_max) in enumerate(selected_product_types, 1):
        sku = f"{prefix}_{i:03d}"
        name = f"{ptype} Model {i}"
        price = round(random.uniform(price_min, price_max), 2)
        
        products.append({
            "sku": sku,
            "name": name,
            "price": price,
            "description": f"High-quality {ptype.lower()} for home and office use"
        })
    
    # Generate materials
    materials = []
    selected_materials = random.sample(material_templates, min(num_materials, len(material_templates)))
    for mat_id, name_en, name_cn, unit, base_stock in selected_materials:
        # Add some randomness to stock (±20%)
        stock = base_stock * random.uniform(0.8, 1.2)
        min_stock = base_stock * 0.03  # 3% of base as minimum (lower percentage since stock is higher)
        
        materials.append({
            "id": mat_id,
            "name_en": name_en,
            "name_cn": name_cn,
            "unit": unit,
            "current_stock": round(stock, 2) if isinstance(stock, float) else int(stock),
            "min_stock": round(min_stock, 2) if isinstance(min_stock, float) else int(min_stock),
            "supplier": f"Supplier {chr(65 + random.randint(0, 5))}"  # Supplier A-F
        })
    
    # Generate BOM (Bill of Materials)
    bom = []
    material_ids = [m["id"] for m in materials]
    
    for product in products:
        # Determine how many materials this product needs
        num_mats = min(materials_per_product + random.randint(-1, 1), len(material_ids))
        num_mats = max(2, num_mats)  # At least 2 materials per product
        
        product_materials = random.sample(material_ids, num_mats)
        
        for mat_id in product_materials:
            # Find material info
            material = next(m for m in materials if m["id"] == mat_id)
            
            # Generate quantity based on material type
            if material["unit"] in ["square meters", "meters"]:
                quantity = round(random.uniform(0.5, 5.0), 1)
            elif material["unit"] == "L":
                quantity = round(random.uniform(0.05, 0.5), 2)
            else:  # pcs
                quantity = random.randint(2, 20)
            
            bom.append({
                "product_sku": product["sku"],
                "product_name": product["name"],
                "material_id": mat_id,
                "material_name": material["name_en"],
                "quantity": quantity,
                "unit": material["unit"]
            })
    
    return {
        "products": products,
        "materials": materials,
        "bom": bom
    }


def calculate_max_producible_quantities(materials: list, bom: list) -> dict:
    """
    Calculate maximum producible quantities for each product based on material inventory

    Args:
        materials: List of material dictionaries with 'id' and 'current_stock'
        bom: List of BOM entries with 'product_sku', 'material_id', and 'quantity'
        
    Returns:
        dict: Maximum producible quantities for each product
    """
    # Build material inventory dict
    material_inventory = {m['id']: m['current_stock'] for m in materials}
    
    # Build BOM dict grouped by product
    bom_by_product = {}
    for entry in bom:
        product_sku = entry['product_sku']
        material_id = entry['material_id']
        quantity = entry['quantity']
        
        if product_sku not in bom_by_product:
            bom_by_product[product_sku] = {}
        bom_by_product[product_sku][material_id] = quantity
    
    # Calculate max quantities for each product
    max_quantities = {}
    
    for product_sku, materials_needed in bom_by_product.items():
        possible_quantities = []
        
        for material_id, unit_requirement in materials_needed.items():
            if material_id not in material_inventory:
                possible_quantities.append(0)
                continue
            
            available_stock = material_inventory[material_id]
            possible_qty = int(available_stock // unit_requirement)
            possible_quantities.append(possible_qty)
        
        # Take minimum value as maximum producible quantity
        max_quantities[product_sku] = min(possible_quantities) if possible_quantities else 0
    
    return max_quantities

def setup_woocommerce_products_local(woocommerce_db_dir: str, products: list, 
                                    materials: list, bom: list) -> dict:
    """Setup test products in WooCommerce using local database
    
    Args:
        woocommerce_db_dir: WooCommerce database directory
        products: List of product dictionaries
        materials: List of material dictionaries
        bom: List of BOM entries
        
    Returns:
        dict: Mapping of SKU to WooCommerce product ID
    """
    logger = setup_logging()
    product_mapping = {}
    
    print("\n🛒 Setting up WooCommerce products (Local Database)...")
    print("=" * 60)
    
    try:
        # Initialize WooCommerce Database
        wc_db = WooCommerceDatabase(data_dir=woocommerce_db_dir)
        
        # Calculate max producible quantities based on material inventory
        max_quantities = calculate_max_producible_quantities(materials, bom)
        print(f"   📊 Calculated max producible quantities: {max_quantities}")
        
        # Create products from generated data
        for product in products:
            sku = product["sku"]
            stock_qty = max_quantities.get(sku, 0)
            
            product_data = {
                "sku": sku,
                "name": product["name"],
                "description": product["description"],
                "regular_price": str(product["price"]),
                "manage_stock": True,
                "stock_quantity": stock_qty,
                "categories": [{"name": "Furniture"}],
                "status": "publish",
                "type": "simple"
            }
            
            try:
                product_id = wc_db.create_product(product_data)
                product_mapping[sku] = product_id
                print(f"   ✓ Created product {sku} with ID {product_id} (stock: {stock_qty})")
            except Exception as e:
                print(f"   ❌ Error creating product {sku}: {e}")
        
        print(f"✅ WooCommerce products setup completed")
        print(f"   Created {len(product_mapping)} products")
        
        return product_mapping
        
    except Exception as e:
        print(f"❌ WooCommerce products setup failed: {e}")
        import traceback
        traceback.print_exc()
        return {}

def setup_test_environment_local(woocommerce_db_dir: str, google_sheet_db_dir: str, task_root: Path, 
                                products: list, materials: list, bom: list, num_orders: int = 3,
                                agent_workspace: str = None) -> bool:
    """Setup test environment with WooCommerce products and Google Sheets using local databases
    
    Args:
        woocommerce_db_dir: WooCommerce database directory
        google_sheet_db_dir: Google Sheets database directory
        task_root: Task root directory
        products: List of product dictionaries
        materials: List of material dictionaries
        bom: List of BOM entries
        num_orders: Number of test orders to generate
        agent_workspace: Agent workspace path (optional)
        
    Returns:
        True if setup succeeded
    """
    logger = setup_logging()
    
    print("\n🚀 Setting up test environment (Local Database)...")
    print("=" * 60)
    
    try:
        # Step 1: Clean and initialize WooCommerce database
        print("\n🗑️ Cleaning WooCommerce database...")
        if Path(woocommerce_db_dir).exists():
            nfs_safe_rmtree(woocommerce_db_dir)
            print("   ✓ Removed old database")
        
        Path(woocommerce_db_dir).mkdir(parents=True, exist_ok=True)
        print("   ✓ Created fresh database directory")
        
        # Initialize WooCommerce database
        print("\n📦 Initializing WooCommerce database...")
        init_woocommerce_db(woocommerce_db_dir, verbose=False, include_demo_data=False)
        print("   ✓ Database initialized")
        
        # Create products in WooCommerce
        product_mapping = setup_woocommerce_products_local(woocommerce_db_dir, products, materials, bom)
        
        # Step 1.5: Create test orders using OrderSimulator
        if OrderSimulator:
            print("\n📦 Creating test orders...")
            try:
                wc_db = WooCommerceDatabase(data_dir=woocommerce_db_dir)
                wc_adapter = WooCommerceDatabaseAdapter(wc_db)
                order_simulator = OrderSimulator(wc_adapter)
                
                # Calculate max producible quantities first
                max_quantities = calculate_max_producible_quantities(materials, bom)
                print(f"   📊 Max producible quantities: {max_quantities}")
                
                # Update OrderSimulator with actual generated products
                order_simulator.available_products = [
                    {"sku": product["sku"], "name": product["name"], "price": product["price"]}
                    for product in products
                ]
                print(f"   ✓ Updated OrderSimulator with {len(products)} available products")
                
                # Generate orders with inventory constraints
                # Limit total orders to avoid exceeding inventory
                test_orders = []
                remaining_product_inventory = max_quantities.copy()
                remaining_material_inventory = {m['id']: m['current_stock'] for m in materials}
                successful_orders = 0
                max_attempts = num_orders * 3  # Allow more attempts to reach target
                attempts = 0
                
                # Build BOM lookup for material consumption calculation
                bom_by_product = {}
                for entry in bom:
                    sku = entry['product_sku']
                    if sku not in bom_by_product:
                        bom_by_product[sku] = {}
                    bom_by_product[sku][entry['material_id']] = entry['quantity']
                
                print(f"   🎲 Generating up to {num_orders} orders with material inventory constraints...")
                
                while successful_orders < num_orders and attempts < max_attempts:
                    attempts += 1
                    
                    # Generate a random order
                    order = order_simulator.generate_random_order()
                    
                    # Check if order can be fulfilled with remaining product inventory
                    can_fulfill = True
                    for item in order.items:
                        if item.sku not in remaining_product_inventory:
                            can_fulfill = False
                            break
                        if remaining_product_inventory[item.sku] < item.quantity:
                            can_fulfill = False
                            break
                    
                    if not can_fulfill:
                        continue
                    
                    # Calculate material consumption for this order
                    material_needed = {}
                    for item in order.items:
                        if item.sku in bom_by_product:
                            for material_id, unit_consumption in bom_by_product[item.sku].items():
                                if material_id not in material_needed:
                                    material_needed[material_id] = 0
                                material_needed[material_id] += unit_consumption * item.quantity
                    
                    # Check if materials are sufficient
                    materials_sufficient = True
                    for material_id, needed in material_needed.items():
                        if material_id not in remaining_material_inventory:
                            materials_sufficient = False
                            break
                        if remaining_material_inventory[material_id] < needed:
                            materials_sufficient = False
                            break
                    
                    if can_fulfill and materials_sufficient:
                        # Deduct from remaining product inventory
                        for item in order.items:
                            remaining_product_inventory[item.sku] -= item.quantity
                        
                        # Deduct from remaining material inventory
                        for material_id, needed in material_needed.items():
                            remaining_material_inventory[material_id] -= needed
                        
                        # Convert order to dict format
                        order_dict = {
                            "order_id": order.order_id,
                            "status": order.status,
                            "payment_status": order.payment_status,
                            "created_at": order.created_at.isoformat(),
                            "customer": order.customer_info,
                            "items": [
                                {
                                    "sku": item.sku,
                                    "name": item.name,
                                    "quantity": item.quantity,
                                    "price": item.price
                                }
                                for item in order.items
                            ],
                            "total": order.total
                        }
                        test_orders.append(order_dict)
                        successful_orders += 1
                    
                    # Check if we're stuck (inventory too low to generate any more orders)
                    if attempts > num_orders * 2 and successful_orders == 0:
                        print(f"   ⚠️  Cannot generate orders: initial inventory too low")
                        break
                
                if successful_orders == 0:
                    print(f"   ❌ Failed to generate any orders!")
                    print(f"   💡 Try: --num-materials {args.num_materials * 2} --num-products {args.num_products // 2}")
                    raise Exception("Cannot generate orders with current inventory configuration")
                
                if successful_orders < num_orders:
                    print(f"   ⚠️  Only generated {successful_orders}/{num_orders} orders due to inventory constraints")
                    print(f"   💡 Consider reducing --num-orders or increasing inventory/materials")
                else:
                    print(f"   ✓ Successfully generated all {successful_orders} orders within inventory limits")
                
                # Save orders to groundtruth_workspace
                groundtruth_orders_file = task_root / "groundtruth_workspace" / "test_orders.json"
                groundtruth_orders_file.parent.mkdir(parents=True, exist_ok=True)
                
                with open(groundtruth_orders_file, 'w', encoding='utf-8') as f:
                    json.dump(test_orders, f, indent=2, ensure_ascii=False)
                
                print(f"   ✓ Created {len(test_orders)} test orders")
                print(f"   ✓ Orders saved to: {groundtruth_orders_file}")
                
                # Write orders to WooCommerce database
                print(f"\n📝 Writing orders to WooCommerce database...")
                orders_written = 0
                for order_dict in test_orders:
                    try:
                        # Convert order_dict to WooCommerce order format
                        line_items = []
                        for item in order_dict["items"]:
                            # Find product_id from product_mapping
                            product_id = product_mapping.get(item["sku"])
                            if product_id:
                                line_items.append({
                                    "product_id": product_id,
                                    "quantity": item["quantity"]
                                })
                        
                        if line_items:
                            order_data = {
                                "status": order_dict["status"],
                                "billing": {
                                    "first_name": order_dict["customer"].get("first_name", "Test"),
                                    "last_name": order_dict["customer"].get("last_name", "Customer"),
                                    "email": order_dict["customer"].get("email", "test@example.com"),
                                    "phone": order_dict["customer"].get("phone", "1234567890"),
                                },
                                "line_items": line_items
                            }
                            
                            # Write to database
                            wc_db.create_order(order_data)
                            orders_written += 1
                    except Exception as e:
                        print(f"   ⚠️  Failed to write order {order_dict['order_id']}: {e}")
                
                print(f"   ✓ Written {orders_written}/{len(test_orders)} orders to WooCommerce database")
                print(f"   📊 Remaining product inventory: {remaining_product_inventory}")
                
                # Check for any negative material inventory (should not happen)
                negative_materials = {k: v for k, v in remaining_material_inventory.items() if v < 0}
                if negative_materials:
                    print(f"   ⚠️  Warning: Negative material inventory detected: {negative_materials}")
                else:
                    print(f"   ✅ All material inventory values are non-negative")
                
                # Calculate expected results based on generated orders and metadata
                print("\n📊 Calculating expected results...")
                try:
                    # Import here to avoid circular dependency
                    # Use regular import since current_dir is already in sys.path
                    from calculate_expected_results import calculate_expected_results  # type: ignore
                    groundtruth_ws_path = str(task_root / "groundtruth_workspace")
                    calculate_expected_results(groundtruth_workspace=groundtruth_ws_path)
                    print(f"   ✓ Expected results calculated and saved")
                except Exception as calc_error:
                    print(f"   ⚠️  Failed to calculate expected results: {calc_error}")
                    import traceback
                    traceback.print_exc()
            except Exception as e:
                print(f"   ⚠️  Order creation failed: {e}")
                import traceback
                traceback.print_exc()
        else:
            print("\n⚠️  OrderSimulator not available, skipping order creation")
        
        # Step 2: Clean and initialize Google Sheets database
        print("\n🗑️ Cleaning Google Sheets database...")
        if Path(google_sheet_db_dir).exists():
            nfs_safe_rmtree(google_sheet_db_dir)
            print("   ✓ Removed old database")
        
        Path(google_sheet_db_dir).mkdir(parents=True, exist_ok=True)
        print("   ✓ Created fresh database directory")
        
        # Setup Google Sheets
        spreadsheet_id = setup_google_sheets_local(google_sheet_db_dir, task_root, materials, bom)
        
        # Step 3: Create config file and save to groundtruth_workspace
        print("\n💾 Creating config file...")
        groundtruth_workspace_dir = task_root / "groundtruth_workspace"
        groundtruth_workspace_dir.mkdir(parents=True, exist_ok=True)
        config_path = groundtruth_workspace_dir / "config.json"
        
        # Create config dictionary
        config = {
            "spreadsheet_id": spreadsheet_id,
            "bom_sheet_name": "BOM",
            "inventory_sheet_name": "Material_Inventory",
            "product_mapping": {}
        }
        
        # Add product mapping with WooCommerce IDs
        for sku, wc_id in product_mapping.items():
            config["product_mapping"][sku] = {
                "woocommerce_id": str(wc_id)
            }
        
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        
        print(f"   ✓ Config saved to: {config_path}")
        print(f"   ✓ Spreadsheet ID: {spreadsheet_id}")
        print(f"   ✓ Product mapping: {len(product_mapping)} products")
        
        print("\n✅ Test environment setup completed successfully!")
        return True
        
    except Exception as e:
        print(f"\n❌ Test environment setup failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--agent_workspace", required=False, help="Agent workspace path")
    parser.add_argument("--launch_time", required=False, help="Launch time")
    
    # Data generation control parameters
    parser.add_argument("--num-products", type=int, default=5,
                       help="Number of products to generate (default: 10)")
    parser.add_argument("--num-materials", type=int, default=10,
                       help="Number of raw materials (default: 20)")
    parser.add_argument("--materials-per-product", type=int, default=3,
                       help="Average number of materials per product BOM (default: 5)")
    parser.add_argument("--num-orders", type=int, default=10,
                       help="Number of test orders to generate (default: 20, actual may be less due to inventory)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed for data generation (default: 42)")
    
    # Difficulty presets
    parser.add_argument("--difficulty", type=str, default=None,
                       choices=["easy", "medium", "hard", "expert", "extreme"],
                       help="Difficulty preset (optional, overrides other parameters)")

    args = parser.parse_args()
    
    # Apply difficulty presets
    if args.difficulty:
        print(f"\n🎲 Using difficulty preset: {args.difficulty.upper()}")
        
        if args.difficulty == "easy":
            # Easy: Few products, few materials, simple BOM
            args.num_products = 2
            args.num_materials = 5
            args.materials_per_product = 3
            args.num_orders = 3  # Small number of orders
        elif args.difficulty == "medium":
            # Medium: Default settings
            args.num_products = 3
            args.num_materials = 8
            args.materials_per_product = 4
            args.num_orders = 5  # Moderate orders
        elif args.difficulty == "hard":
            # Hard: More products and materials
            args.num_products = 5
            args.num_materials = 12
            args.materials_per_product = 5
            args.num_orders = 10  # More orders
        elif args.difficulty == "expert":
            # Expert: Many products with complex BOM
            args.num_products = 8
            args.num_materials = 20
            args.materials_per_product = 6
            args.num_orders = 15  # Many orders
        elif args.difficulty == "extreme":
            # Extreme: Large scale inventory management
            args.num_products = 12
            args.num_materials = 25
            args.materials_per_product = 7
            args.num_orders = 25  # High volume orders
    else:
        print(f"\n🎲 Using custom parameters")
    
    logger = setup_logging()
    
    print("\n" + "=" * 60)
    print("🎯 Material Inventory Management - Preprocessing")
    print("=" * 60)
    print("Using local databases (WooCommerce + Google Sheets)")
    
    print(f"\n📊 Data generation parameters:")
    print(f"   Products: {args.num_products}")
    print(f"   Materials: {args.num_materials}")
    print(f"   Materials per product: {args.materials_per_product}")
    print(f"   Orders: {args.num_orders}")
    print(f"   Random seed: {args.seed}")
    
    # Get task root directory
    # When agent_workspace is provided, task_root is its parent directory
    # Otherwise, assume we're in mcpbench_dev task structure
    if args.agent_workspace:
        task_root = Path(args.agent_workspace).parent
    else:
        task_root = Path(__file__).parent.parent
    
    # Determine database directories
    if args.agent_workspace:
        workspace_parent = Path(args.agent_workspace).parent
        woocommerce_db_dir = str(workspace_parent / "local_db" / "woocommerce")
        google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
    else:
        woocommerce_db_dir = str(Path(__file__).parent.parent / "local_db" / "woocommerce")
        google_sheet_db_dir = str(Path(__file__).parent.parent / "local_db" / "google_sheets")
    
    print(f"\n📂 Database Directories:")
    print(f"   WooCommerce: {woocommerce_db_dir}")
    print(f"   Google Sheets: {google_sheet_db_dir}")
    
    # Generate inventory data (products, materials, BOM)
    print(f"\n🎲 Generating inventory data...")
    print("=" * 60)
    inventory_data = generate_inventory_data(
        num_products=args.num_products,
        num_materials=args.num_materials,
        materials_per_product=args.materials_per_product,
        seed=args.seed
    )
    
    products = inventory_data['products']
    materials = inventory_data['materials']
    bom = inventory_data['bom']
    
    print(f"   ✓ Generated {len(products)} products")
    print(f"   ✓ Generated {len(materials)} materials")
    print(f"   ✓ Generated {len(bom)} BOM entries")
    
    # Save generation metadata for evaluation
    metadata = {
        "generation_params": {
            "num_products": args.num_products,
            "num_materials": args.num_materials,
            "materials_per_product": args.materials_per_product,
            "num_orders": args.num_orders,
            "seed": args.seed,
            "difficulty": args.difficulty if args.difficulty else "custom"
        },
        "generated_data": {
            "products_count": len(products),
            "materials_count": len(materials),
            "bom_entries_count": len(bom),
            "products": products,
            "materials": materials,
            "bom": bom
        }
    }
    
    # Save to groundtruth_workspace
    groundtruth_workspace = task_root / "groundtruth_workspace"
    groundtruth_workspace.mkdir(parents=True, exist_ok=True)
    metadata_file = groundtruth_workspace / "generation_metadata.json"
    
    try:
        with open(metadata_file, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
        print(f"   ✓ Saved generation metadata to: {metadata_file}")
    except Exception as e:
        print(f"   ⚠️  Failed to save metadata: {e}")
    
    # Note: calculate_expected_results will be called after orders are created
    # (inside setup_test_environment_local)
    
    # Setup test environment
    if not setup_test_environment_local(
        woocommerce_db_dir=woocommerce_db_dir,
        google_sheet_db_dir=google_sheet_db_dir,
        task_root=task_root,
        products=products,
        materials=materials,
        bom=bom,
        num_orders=args.num_orders,
        agent_workspace=args.agent_workspace
    ):
        print("\n❌ Preprocessing failed")
        sys.exit(1)
    
    # Set environment variables
    os.environ['WOOCOMMERCE_DATA_DIR'] = woocommerce_db_dir
    os.environ['GOOGLE_SHEET_DATA_DIR'] = google_sheet_db_dir
    
    # Write environment variable file
    if args.agent_workspace:
        env_file = Path(args.agent_workspace).parent / "local_db" / ".env"
    else:
        env_file = Path(woocommerce_db_dir).parent / ".env"
    
    try:
        env_file.parent.mkdir(parents=True, exist_ok=True)
        with open(env_file, 'w') as f:
            f.write(f"# Material Inventory Management Environment Variables\n")
            f.write(f"# Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write(f"export WOOCOMMERCE_DATA_DIR={woocommerce_db_dir}\n")
            f.write(f"export GOOGLE_SHEET_DATA_DIR={google_sheet_db_dir}\n")
        print(f"\n📄 Environment variable file created: {env_file}")
    except Exception as e:
        print(f"⚠️ Unable to create environment variable file: {e}")
    
    print("\n" + "=" * 60)
    print("🎉 Preprocessing completed successfully!")
    print("=" * 60)
    print(f"✅ WooCommerce database initialized with products")
    print(f"✅ Google Sheets database initialized with BOM and inventory")
    print(f"✅ Config file saved to groundtruth_workspace")
    
    if OrderSimulator:
        print(f"✅ Test orders created and saved to groundtruth_workspace")
    
    # Display generation statistics
    print(f"\n📊 Generated Data Statistics:")
    print(f"   Products: {len(products)}")
    for product in products:
        print(f"      • {product['sku']}: {product['name']} (${product['price']})")
    
    print(f"\n   Materials: {len(materials)}")
    material_count_display = min(5, len(materials))
    for i, material in enumerate(materials[:material_count_display]):
        print(f"      • {material['id']}: {material['name_cn']} ({material['current_stock']} {material['unit']})")
    if len(materials) > material_count_display:
        print(f"      • ... and {len(materials) - material_count_display} more materials")
    
    print(f"\n   BOM Entries: {len(bom)}")
    bom_by_product = {}
    for entry in bom:
        sku = entry['product_sku']
        if sku not in bom_by_product:
            bom_by_product[sku] = 0
        bom_by_product[sku] += 1
    for sku, count in bom_by_product.items():
        print(f"      • {sku}: {count} materials required")
    
    if args.difficulty:
        print(f"\n🎮 Difficulty Level: {args.difficulty.upper()}")
    
    print(f"\n📌 Environment Variables:")
    print(f"   WOOCOMMERCE_DATA_DIR={woocommerce_db_dir}")
    print(f"   GOOGLE_SHEET_DATA_DIR={google_sheet_db_dir}")
    
    print(f"\n💡 Next Steps:")
    print(f"   Agent can use the following MCP servers:")
    print(f"   • google_sheet - Read BOM and inventory data")
    print(f"   • woocommerce - Update product stock quantities")
    
    print(f"\n📝 Task Description:")
    print(f"   • Read BOM from Google Sheets to understand product-material relationships")
    print(f"   • Read material inventory from Google Sheets")
    print(f"   • Calculate max producible quantities based on material inventory")
    print(f"   • Update WooCommerce product stock quantities accordingly")
    print(f"   • Process orders will reduce both product stock and material inventory")
    
    sys.exit(0)