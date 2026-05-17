#!/usr/bin/env python3
"""
Calculate expected results based on generated test orders and initial inventory
"""

import json
import os
from typing import Dict, Any

def load_json(file_path: str) -> Any:
    """Load JSON file"""
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_json(data: Any, file_path: str) -> None:
    """Save JSON file"""
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def calculate_expected_results(groundtruth_workspace: str = None):
    """Calculate expected results

    Args:
        groundtruth_workspace: Path to groundtruth workspace (optional, will try to infer if not provided)
    """

    # File paths
    if groundtruth_workspace:
        # Use provided groundtruth_workspace path
        print(f"   Using provided groundtruth_workspace: {groundtruth_workspace}")
        task_groundtruth_dir = groundtruth_workspace
    else:
        # Try to infer from relative path (fallback for standalone execution)
        current_dir = os.path.dirname(os.path.abspath(__file__))
        task_dir = os.path.dirname(current_dir)
        task_groundtruth_dir = os.path.join(task_dir, "groundtruth_workspace")
        print(f"   Inferred groundtruth_workspace from relative path: {task_groundtruth_dir}")
    
    test_orders_path = os.path.join(task_groundtruth_dir, "test_orders.json")
    metadata_path = os.path.join(task_groundtruth_dir, "generation_metadata.json")
    output_path = os.path.join(task_groundtruth_dir, "expected_results.json")
    
    print(f"   Looking for test_orders.json at: {test_orders_path}")
    print(f"   Looking for generation_metadata.json at: {metadata_path}")
    
    # Load data
    test_orders = load_json(test_orders_path)

    # Get generated data from generation_metadata.json
    metadata = load_json(metadata_path)
    generated_data = metadata["generated_data"]
    products = generated_data["products"]
    materials = generated_data["materials"]
    bom_entries = generated_data["bom"]

    # Build initial product inventory (calculate max_producible_quantities from products)
    material_inventory = {m["id"]: m["current_stock"] for m in materials}

    # Build BOM dictionary
    bom_data = {}
    for entry in bom_entries:
        sku = entry["product_sku"]
        if sku not in bom_data:
            bom_data[sku] = {}
        bom_data[sku][entry["material_id"]] = entry["quantity"]
    
    # Calculate initial product inventory (max producible quantities)
    initial_product_inventory = {}
    for product in products:
        sku = product["sku"]
        if sku in bom_data:
            # Calculate the maximum producible quantity for this product
            possible_quantities = []
            for material_id, unit_requirement in bom_data[sku].items():
                if material_id in material_inventory:
                    available_stock = material_inventory[material_id]
                    possible_qty = int(available_stock // unit_requirement)
                    possible_quantities.append(possible_qty)
            initial_product_inventory[sku] = min(possible_quantities) if possible_quantities else 0
        else:
            initial_product_inventory[sku] = 0

    initial_material_inventory = material_inventory

    # Calculate total order quantities
    total_quantities_ordered = {}
    for order in test_orders:
        for item in order["items"]:
            sku = item["sku"]
            quantity = item["quantity"]
            total_quantities_ordered[sku] = total_quantities_ordered.get(sku, 0) + quantity
    
    # Calculate material consumption
    expected_material_consumption = {}
    calculation_details = {
        "product_inventory": {},
        "material_consumption": {}
    }

    # Calculate material consumption for each product
    for sku, quantity in total_quantities_ordered.items():
        if sku in bom_data:
            calculation_details["material_consumption"][f"{sku}_consumption"] = {}
            for material, unit_consumption in bom_data[sku].items():
                total_consumption = quantity * unit_consumption
                expected_material_consumption[material] = expected_material_consumption.get(material, 0) + total_consumption
                calculation_details["material_consumption"][f"{sku}_consumption"][material] = f"{quantity} × {unit_consumption} = {total_consumption}"
    
    # Calculate final inventory
    expected_final_woocommerce = {}
    expected_final_material = {}

    # # Product inventory update
    # for sku, initial_qty in initial_product_inventory.items():
    #     ordered_qty = total_quantities_ordered.get(sku, 0)
    #     final_qty = initial_qty - ordered_qty
    #     expected_final_woocommerce[sku] = final_qty
    #     calculation_details["product_inventory"][sku] = f"{initial_qty} - {ordered_qty} = {final_qty} (initial stock {initial_qty}, total ordered {ordered_qty})"

    # Material inventory update
    calculation_details["material_consumption"]["material_inventory_deduction"] = {}
    for material, initial_qty in initial_material_inventory.items():
        consumed_qty = expected_material_consumption.get(material, 0)
        final_qty = initial_qty - consumed_qty
        expected_final_material[material] = final_qty
        calculation_details["material_consumption"]["material_inventory_deduction"][material] = f"{initial_qty} - {consumed_qty} = {final_qty}"



    for sku, initial_qty in initial_product_inventory.items():
        bom_data_sku = bom_data[sku]
        material_constraints = []  # Store production constraints for each raw material

        for material, unit_consumption in bom_data_sku.items():
            if material in expected_final_material:
                available_material = expected_final_material[material]
                # Calculate the maximum production quantity supported by this raw material
                max_production_for_material = available_material / unit_consumption
                material_constraints.append(max_production_for_material)

        # Apply minimum constraint principle: take the minimum of all raw material constraints and round down
        sku_max_production = int(min(material_constraints)) if material_constraints else 0
        expected_final_woocommerce[sku] = sku_max_production







    
    # Build expected results
    expected_results = {
        "task_description": "Raw material inventory automatic management task - groundtruth for verification",
        "test_orders_summary": {
            "total_quantities_ordered": total_quantities_ordered
        },
        "initial_inventories": {
            "product_inventory": initial_product_inventory,
            "material_inventory": initial_material_inventory
        },
        "bom_data": bom_data,
        "expected_material_consumption": expected_material_consumption,
        "expected_final_inventories": {
            "woocommerce_inventory": expected_final_woocommerce,
            "google_sheets_material_inventory": expected_final_material
        },
        "calculation_details": calculation_details,
        "evaluation_criteria": {
            "description": "Verify that WooCommerce product inventory and Google Sheets raw material inventory are correctly updated after agent processes orders",
            "woocommerce_tolerance": 0,
            "material_inventory_tolerance": 0.01,
            "required_accuracy": "100%"
        }
    }
    
    # Save results
    save_json(expected_results, output_path)
    print(f"Expected results calculated and saved to: {output_path}")

    # Print summary
    print("\nOrder summary:")
    for sku, qty in total_quantities_ordered.items():
        print(f"  {sku}: {qty}")

    print("\nMaterial consumption:")
    for material, consumption in expected_material_consumption.items():
        print(f"  {material}: {consumption}")

if __name__ == "__main__":
    import sys
    
    # Support command line argument for groundtruth_workspace
    groundtruth_ws = None
    if len(sys.argv) > 1:
        groundtruth_ws = sys.argv[1]
        print(f"Using groundtruth_workspace from command line: {groundtruth_ws}")
    else:
        print("No groundtruth_workspace provided, will try to infer from relative path")
    
    calculate_expected_results(groundtruth_workspace=groundtruth_ws)