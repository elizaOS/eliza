#!/usr/bin/env python3
"""
WooCommerce inventory sync evaluation script (using local database)
"""

import os
import sys
import json
import logging
from typing import Dict, List, Tuple, Optional
from pathlib import Path

current_dir = os.path.dirname(os.path.abspath(__file__))


from mcp_convert.mcps.woocommerce.database_utils import WooCommerceDatabase

def setup_logging():
    """Setup logging"""
    logging.basicConfig(level=logging.INFO)
    return logging.getLogger(__name__)

def load_expected_results(groundtruth_workspace: Optional[str] = None) -> Optional[Dict]:
    """Load expected results
    
    Args:
        groundtruth_workspace: Optional path to groundtruth workspace
    """
    result_files = []
    
    # Try groundtruth_workspace parameter first (most reliable)
    if groundtruth_workspace:
        result_files.append(os.path.join(groundtruth_workspace, 'expected_results.json'))
    
    # Fallback to relative paths
    result_files.append(os.path.join(os.path.dirname(current_dir), 'groundtruth_workspace', 'expected_results.json'))

    logger = setup_logging()
    for result_file in result_files:
        try:
            logger.info(f"Trying to load expected results from: {result_file}")
            if os.path.exists(result_file):
                with open(result_file, 'r', encoding='utf-8') as f:
                    logger.info(f"✓ Successfully loaded from: {result_file}")
                    return json.load(f)
            else:
                logger.warning(f"File not found: {result_file}")
        except Exception as e:
            logger.warning(f"Failed to load from {result_file}: {e}")
            continue

    return None

def load_agent_config(workspace_path: str, groundtruth_workspace: Optional[str] = None) -> Optional[Dict]:
    """Load configuration from agent workspace or groundtruth workspace
    
    Args:
        workspace_path: Agent workspace path
        groundtruth_workspace: Optional path to groundtruth workspace
    """
    # Try multiple possible config file locations
    # Priority: groundtruth_workspace parameter > groundtruth_workspace relative > workspace
    config_paths = []
    
    # Add groundtruth_workspace parameter path first
    if groundtruth_workspace:
        config_paths.append(os.path.join(groundtruth_workspace, 'config.json'))
    
    # Add fallback paths
    config_paths.extend([
        os.path.join(os.path.dirname(current_dir), 'groundtruth_workspace', 'config.json'),
        os.path.join(workspace_path, 'config.json'),
        os.path.join(workspace_path, 'initial_workspace', 'config.json'),
        os.path.join(os.path.dirname(current_dir), 'initial_workspace', 'config.json')
    ])

    logger = setup_logging()
    for config_path in config_paths:
        try:
            logger.info(f"Trying to load config from: {config_path}")
            if os.path.exists(config_path):
                with open(config_path, 'r', encoding='utf-8') as f:
                    logger.info(f"✓ Successfully loaded config from: {config_path}")
                    return json.load(f)
            else:
                logger.warning(f"Config not found: {config_path}")
        except Exception as e:
            logger.warning(f"Failed to load from {config_path}: {e}")
            continue
    return None

def check_woocommerce_inventory_sync(woocommerce_db: WooCommerceDatabase, expected_inventory: Dict[str, int]) -> Tuple[bool, Dict]:
    """
    Check if WooCommerce product inventory is correctly synced (using local database)

    Args:
        woocommerce_db: WooCommerceDatabase instance
        expected_inventory: Expected product inventory state

    Returns:
        (Whether check passed, Check result details)
    """
    logger = setup_logging()

    try:
        # Get all products from local database (returns a list of dicts)
        all_products = woocommerce_db.list_products()
        if not all_products:
            return False, {'error': 'No products found in WooCommerce database'}

        # Build SKU to product mapping
        sku_to_product = {}
        for product in all_products:
            sku = product.get('sku')
            if sku:
                sku_to_product[sku] = product

        # Check inventory for each product
        results = {
            'product_checks': {},
            'total_products_checked': 0,
            'correctly_synced': 0,
            'incorrectly_synced': 0,
            'missing_products': []
        }

        for product_sku, expected_stock in expected_inventory.items():
            results['total_products_checked'] += 1

            if product_sku not in sku_to_product:
                results['missing_products'].append(product_sku)
                results['product_checks'][product_sku] = {
                    'status': 'missing_product',
                    'expected_stock': expected_stock,
                    'actual_stock': None
                }
                results['incorrectly_synced'] += 1
                logger.warning(f"❌ Product {product_sku} not found in database")
                continue

            product = sku_to_product[product_sku]
            current_stock = product.get('stock_quantity', 0)

            # Ensure comparison is with integers
            if isinstance(current_stock, str):
                try:
                    current_stock = int(current_stock)
                except ValueError:
                    current_stock = 0

            is_correct = current_stock == expected_stock

            results['product_checks'][product_sku] = {
                'status': 'correct' if is_correct else 'incorrect',
                'expected_stock': expected_stock,
                'actual_stock': current_stock,
                'difference': current_stock - expected_stock,
                'product_id': product.get('id'),
                'product_name': product.get('name', '')
            }

            if is_correct:
                results['correctly_synced'] += 1
                logger.info(f"✅ {product_sku} ({product.get('name', '')}): {current_stock} (expected: {expected_stock})")
            else:
                results['incorrectly_synced'] += 1
                logger.warning(f"❌ {product_sku} ({product.get('name', '')}): {current_stock} (expected: {expected_stock}, diff: {current_stock - expected_stock})")

        # Require ALL products to have exact inventory match (no tolerance for errors)
        overall_pass = results['incorrectly_synced'] == 0 and results['correctly_synced'] > 0

        results['overall_pass'] = overall_pass

        return overall_pass, results

    except Exception as e:
        logger.error(f"Failed to check WooCommerce inventory sync: {e}")
        import traceback
        traceback.print_exc()
        return False, {'error': str(e)}

def evaluate_woocommerce_sync(workspace_path: str, woocommerce_db: WooCommerceDatabase, groundtruth_workspace: Optional[str] = None) -> Dict:
    """Evaluate WooCommerce sync functionality (using local database)
    
    Args:
        workspace_path: Agent workspace path
        woocommerce_db: WooCommerceDatabase instance
        groundtruth_workspace: Optional path to groundtruth workspace
    """
    logger = setup_logging()
    logger.info(f"Starting WooCommerce sync evaluation: {workspace_path}")
    if groundtruth_workspace:
        logger.info(f"Using groundtruth workspace: {groundtruth_workspace}")

    results = {
        'status': 'success',
        'checks': {},
        'issues': [],
        'score': 0.0
    }

    # Load expected results
    logger.info("Loading expected results...")
    expected_results = load_expected_results(groundtruth_workspace)
    if not expected_results:
        error_msg = 'Unable to load expected results file'
        results['status'] = 'failed'
        results['issues'].append(error_msg)
        logger.error(error_msg)
        return results
    logger.info(f"✓ Expected results loaded successfully")

    # Get expected WooCommerce inventory state
    expected_wc_inventory = expected_results.get('expected_final_inventories', {}).get('woocommerce_inventory', {})
    if not expected_wc_inventory:
        error_msg = 'WooCommerce inventory state not found in expected results'
        results['status'] = 'failed'
        results['issues'].append(error_msg)
        logger.error(error_msg)
        logger.error(f"Expected results keys: {list(expected_results.keys())}")
        if 'expected_final_inventories' in expected_results:
            logger.error(f"expected_final_inventories keys: {list(expected_results['expected_final_inventories'].keys())}")
        return results
    logger.info(f"✓ Expected WooCommerce inventory: {len(expected_wc_inventory)} products")

    # Check WooCommerce inventory sync using local database
    sync_pass, sync_results = check_woocommerce_inventory_sync(woocommerce_db, expected_wc_inventory)
    results['checks']['inventory_sync'] = sync_results

    if not sync_pass:
        results['issues'].append('WooCommerce inventory sync is incorrect')
        results['status'] = 'failed'

    # Calculate final score based on strict match requirement
    results['score'] = 1.0 if sync_pass else 0.0

    return results

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python check_woocommerce.py <workspace_path>")
        sys.exit(1)

    workspace_path = sys.argv[1]
    result = evaluate_woocommerce_sync(workspace_path)

    print(json.dumps(result, ensure_ascii=False, indent=2))