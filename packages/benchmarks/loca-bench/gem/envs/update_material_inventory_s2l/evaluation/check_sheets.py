#!/usr/bin/env python3
"""
Evaluation script for checking Google Sheets inventory updates (using local database)
"""

import os
import sys
import json
import logging
from typing import Dict, List, Tuple, Optional
from pathlib import Path

current_dir = os.path.dirname(os.path.abspath(__file__))

from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase

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

def check_sheets_inventory_updates(google_sheet_db: GoogleSheetDatabase, spreadsheet_id: str, expected_final_inventory: Dict[str, float]) -> Tuple[bool, Dict]:
    """
    Check if inventory in Google Sheets is correctly updated (using local database)

    Args:
        google_sheet_db: GoogleSheetDatabase instance
        spreadsheet_id: Spreadsheet ID
        expected_final_inventory: Expected final inventory state

    Returns:
        (Whether check passed, Check result details)
    """
    logger = setup_logging()
    
    try:
        # Get Material_Inventory sheet data from local database
        # First, get the spreadsheet to find the sheet
        spreadsheet = google_sheet_db.get_spreadsheet(spreadsheet_id)
        if not spreadsheet:
            return False, {'error': f'Spreadsheet {spreadsheet_id} not found in local database'}
        
        # Find Material_Inventory sheet
        sheets = spreadsheet.get('sheets', [])
        inventory_sheet = next((s for s in sheets if s['properties']['title'] == 'Material_Inventory'), None)
        
        if not inventory_sheet:
            return False, {'error': 'Material_Inventory sheet not found in spreadsheet'}
        
        # Get cell values from the sheet (assuming format: Material ID | Name | Current Stock | Unit | ...)
        # Use get_values to get 2D array format
        values = google_sheet_db.get_values(spreadsheet_id, "Material_Inventory", "A:F")
        
        if not values:
            return False, {'error': 'Failed to get current inventory from sheets'}
        
        # Parse inventory data (skip header row)
        current_inventory = {}
        for i, row in enumerate(values):
            if i == 0:  # Skip header
                continue
            if len(row) < 3:  # Need at least material ID, name, and stock
                continue
            
            # Handle material_id - could be string or already processed
            material_id = str(row[0]).strip() if row[0] else None
            
            # Handle current_stock - could be string, int, float, or None
            current_stock_raw = row[2] if len(row) > 2 else None
            
            if material_id:
                try:
                    if current_stock_raw is None or current_stock_raw == "":
                        current_stock = 0.0
                    elif isinstance(current_stock_raw, (int, float)):
                        current_stock = float(current_stock_raw)
                    else:
                        # It's a string, strip and convert
                        current_stock = float(str(current_stock_raw).strip())
                    current_inventory[material_id] = current_stock
                except (ValueError, TypeError) as e:
                    logger.warning(f"Could not parse stock value for {material_id}: {current_stock_raw} ({type(current_stock_raw).__name__})")
                    current_inventory[material_id] = 0.0
        
        # Check inventory updates for each material
        results = {
            'material_checks': {},
            'total_materials_checked': 0,
            'correctly_updated': 0,
            'incorrectly_updated': 0,
            'missing_materials': []
        }
        
        for material_id, expected_qty in expected_final_inventory.items():
            results['total_materials_checked'] += 1
            
            if material_id not in current_inventory:
                results['material_checks'][material_id] = {
                    'status': 'missing_in_current',
                    'expected_final': expected_qty,
                    'actual': None
                }
                results['incorrectly_updated'] += 1
                results['missing_materials'].append(material_id)
                continue
            
            actual_qty = current_inventory[material_id]
            
            # Allow decimal precision error
            tolerance = 0.01
            is_correct = abs(actual_qty - expected_qty) <= tolerance
            
            results['material_checks'][material_id] = {
                'status': 'correct' if is_correct else 'incorrect',
                'expected_final': expected_qty,
                'actual': actual_qty,
                'difference': actual_qty - expected_qty,
                'within_tolerance': is_correct
            }
            
            if is_correct:
                results['correctly_updated'] += 1
                logger.info(f"✅ {material_id}: {actual_qty} (expected: {expected_qty})")
            else:
                results['incorrectly_updated'] += 1
                logger.warning(f"❌ {material_id}: {actual_qty} (expected: {expected_qty}, diff: {actual_qty - expected_qty})")
        
        # Require ALL materials to be correctly updated (no tolerance for errors)
        overall_pass = results['incorrectly_updated'] == 0 and results['correctly_updated'] > 0

        results['overall_pass'] = overall_pass

        return overall_pass, results
        
    except Exception as e:
        logger.error(f"Failed to check inventory updates: {e}")
        import traceback
        traceback.print_exc()
        return False, {'error': str(e)}


def evaluate_sheets_integration(workspace_path: str, google_sheet_db: GoogleSheetDatabase, groundtruth_workspace: Optional[str] = None) -> Dict:
    """Evaluate Google Sheets integration (using local database)
    
    Args:
        workspace_path: Agent workspace path
        google_sheet_db: GoogleSheetDatabase instance
        groundtruth_workspace: Optional path to groundtruth workspace
    """
    logger = setup_logging()
    logger.info(f"Starting Google Sheets integration evaluation: {workspace_path}")
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

    # Load configuration from agent workspace
    logger.info(f"Loading configuration from {workspace_path}...")
    agent_config = load_agent_config(workspace_path, groundtruth_workspace)
    if not agent_config:
        error_msg = 'Unable to load configuration file from workspace'
        results['status'] = 'failed'
        results['issues'].append(error_msg)
        logger.error(error_msg)
        return results
    logger.info(f"✓ Configuration loaded successfully")

    # Get spreadsheet ID
    spreadsheet_id = agent_config.get('spreadsheet_id')
    if not spreadsheet_id:
        error_msg = 'spreadsheet_id not found in configuration'
        results['status'] = 'failed'
        results['issues'].append(error_msg)
        logger.error(error_msg)
        return results
    logger.info(f"✓ Spreadsheet ID: {spreadsheet_id}")

    # Get expected final inventory state
    expected_final_inventory = expected_results.get('expected_final_inventories', {}).get('google_sheets_material_inventory', {})
    if not expected_final_inventory:
        error_msg = 'Google Sheets final inventory state not found in expected results'
        results['status'] = 'failed'
        results['issues'].append(error_msg)
        logger.error(error_msg)
        return results
    logger.info(f"✓ Expected final inventory: {len(expected_final_inventory)} materials")
    
    # Check inventory updates using local database
    sheets_pass, sheets_results = check_sheets_inventory_updates(
        google_sheet_db, spreadsheet_id, expected_final_inventory
    )
    results['checks']['sheets_updates'] = sheets_results
    
    if not sheets_pass:
        results['issues'].append('Google Sheets inventory updates are incorrect')

    # Calculate final score based on strict match requirement
    results['score'] = 1.0 if sheets_pass else 0.0

    # Status is failed if not perfect match
    if not sheets_pass:
        results['status'] = 'failed'

    return results

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python check_sheets.py <workspace_path>")
        sys.exit(1)
    
    workspace_path = sys.argv[1]
    result = evaluate_sheets_integration(workspace_path)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))