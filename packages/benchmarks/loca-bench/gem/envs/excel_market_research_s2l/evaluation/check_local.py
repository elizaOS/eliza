import os
import json
import traceback
import numpy as np


def check_local(agent_workspace: str, groundtruth_workspace: str):
    """
    Check if agent's growth rate calculation matches groundtruth.
    Supports dynamic column names based on generated data.
    """
    # Check agent's growth rate file
    agent_growth_file = os.path.join(agent_workspace, "growth_rate.xlsx")
    
    # Construct absolute paths for groundtruth files
    groundtruth_file = os.path.abspath(os.path.join(groundtruth_workspace, "Market_Data_gt.csv"))
    metadata_file = os.path.abspath(os.path.join(groundtruth_workspace, "metadata.json"))
    
    if not os.path.exists(agent_growth_file):
        return False, "growth_rate.xlsx not exists"
    
    if not os.path.exists(groundtruth_file):
        return False, "groundtruth Market_Data_gt.csv not exist"
    
    # Load metadata to get expected column names and conversion weights
    expected_columns = {}
    categories_to_skip = []  # Categories with 0 weight - don't need to check
    target_category = 'Target'
    
    if os.path.exists(metadata_file):
        try:
            with open(metadata_file, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
            
            # Get raw category names and target internal category
            raw_categories = metadata.get('raw_categories', [])
            target_category = metadata.get('target_category', 'Target')
            
            # Get conversion weights to identify categories with 0 contribution
            conversion_weights = metadata.get('conversion_weights', {})
            target_weights = conversion_weights.get(target_category, {})
            
            # Identify categories with 0 weight - these don't contribute to target category
            for cat in raw_categories:
                weight = target_weights.get(cat, 0.0)
                if weight == 0.0:
                    categories_to_skip.append(f'{cat} %')
            
            print(f"📊 Metadata loaded:")
            print(f"   Target category: {target_category}")
            print(f"   Raw categories: {raw_categories}")
            if categories_to_skip:
                print(f"   Categories to skip (0 weight): {categories_to_skip}")
            
            # Build expected column mapping
            expected_columns['Year'] = 'Year'
            expected_columns['Growth Rate %'] = 'Growth Rate %'
            
            for cat in raw_categories:
                expected_columns[f'{cat} %'] = f'{cat} %'
            
        except Exception as e:
            print(f"⚠️  Warning: Could not load metadata.json: {e}")
            print(f"   Will attempt dynamic column detection")
    
    try:
        # Load CSV with pandas
        import pandas as pd
        from openpyxl import load_workbook
        
        # Load groundtruth file
        df_gt = pd.read_csv(groundtruth_file)
        
        print(f"\n📋 Ground truth columns: {df_gt.columns.tolist()}")
        
        # Identify columns dynamically
        year_col_gt = None
        growth_col_gt = None
        category_cols_gt = {}  # Maps category name to column name
        
        for col in df_gt.columns:
            if col == 'Year':
                year_col_gt = col
            elif col == 'Growth Rate %':
                growth_col_gt = col
            elif col.endswith(' %'):
                # This is a category growth rate column
                category_name = col  # Keep full name with %
                category_cols_gt[category_name] = col
        
        # Validate required columns
        if year_col_gt is None:
            return False, "groundtruth does not contain 'Year' column"
        if growth_col_gt is None:
            return False, "groundtruth does not contain 'Growth Rate %' column"
        if not category_cols_gt:
            return False, "groundtruth does not contain any category growth rate columns"
        
        print(f"✅ Found columns:")
        print(f"   Year: {year_col_gt}")
        print(f"   Growth Rate: {growth_col_gt}")
        print(f"   Categories: {list(category_cols_gt.keys())}")
        
        # Extract groundtruth data
        correct_data = {}
        for _, row in df_gt.iterrows():
            year = row[year_col_gt]
            if pd.isna(year):
                continue
            
            year_data = {}
            
            # Parse growth rate for target category
            growth_rate = parse_growth_rate(row[growth_col_gt])
            year_data['growth_rate'] = growth_rate
            
            # Parse growth rates for all raw categories
            for cat_col in category_cols_gt.keys():
                cat_rate = parse_growth_rate(row[cat_col])
                year_data[cat_col] = cat_rate
            
            correct_data[year] = year_data
        
        if not correct_data:
            return False, "groundtruth does not contain valid data"
        
        print(f"✅ Loaded {len(correct_data)} years of groundtruth data")
        
        # Load agent's growth rate file
        wb_agent = load_workbook(agent_growth_file, data_only=True)
        ws_agent = wb_agent.active
        
        # Check if file has data
        if ws_agent.max_row < 2:
            return False, "not enough data in agent growth rate file"
        
        # Read agent's headers
        agent_headers = []
        for col in range(1, ws_agent.max_column + 1):
            header = str(ws_agent.cell(1, col).value or '').strip()
            agent_headers.append(header)
        
        print(f"\n📋 Agent headers: {agent_headers}")
        
        # Map agent's column indices
        year_col_agent = None
        growth_col_agent = None
        category_cols_agent = {}  # Maps category name to column index
        
        for col in range(1, ws_agent.max_column + 1):
            header = str(ws_agent.cell(1, col).value or '').strip()
            if header == 'Year':
                year_col_agent = col
            elif header == 'Growth Rate %':
                growth_col_agent = col
            elif header.endswith(' %'):
                # This is a category growth rate column
                category_cols_agent[header] = col
        
        # Validate agent's columns
        if year_col_agent is None:
            return False, "agent result does not contain 'Year' column"
        if growth_col_agent is None:
            return False, "agent result does not contain 'Growth Rate %' column"
        
        # Check that agent has all required category columns
        # But don't require columns with 0 weight
        missing_categories = []
        for cat_col in category_cols_gt.keys():
            if cat_col not in category_cols_agent:
                # Only report as missing if it's not a 0-weight category
                if cat_col not in categories_to_skip:
                    missing_categories.append(cat_col)
        
        if missing_categories:
            return False, f"agent result missing columns: {missing_categories}"
        
        print(f"✅ Agent has all required columns")
        
        # Extract agent's data
        agent_data = {}
        for row in range(2, ws_agent.max_row + 1):
            year = ws_agent.cell(row, year_col_agent).value
            if year is None:
                continue
            
            year_data = {}
            
            # Parse growth rate for target category
            growth_rate = parse_growth_rate(ws_agent.cell(row, growth_col_agent).value)
            year_data['growth_rate'] = growth_rate
            
            # Parse growth rates for all raw categories
            for cat_col, col_idx in category_cols_agent.items():
                if cat_col in category_cols_gt:  # Only check columns that exist in groundtruth
                    cat_rate = parse_growth_rate(ws_agent.cell(row, col_idx).value)
                    year_data[cat_col] = cat_rate
            
            agent_data[year] = year_data
        
        if not agent_data:
            return False, "agent results do not contain valid data"
        
        print(f"✅ Loaded {len(agent_data)} years of agent data")
        
        # Compare data
        # Allow 1.0% difference to account for rounding in intermediate calculations
        # This is reasonable for growth rate calculations where Excel data is rounded to 2 decimals
        tolerance = 1.0  # Allow 1.0% difference
        total_comparisons = 0
        successful_matches = 0
        failed_comparisons = []
        
        for year in correct_data.keys():
            if year not in agent_data:
                failed_comparisons.append(f"Year {year} missing in agent data")
                continue
            
            correct_year_data = correct_data[year]
            agent_year_data = agent_data[year]
            
            # Build list of columns to check (growth_rate + all categories)
            # But skip categories with 0 weight
            columns_to_check = ['growth_rate']
            for cat_col in category_cols_gt.keys():
                if cat_col not in categories_to_skip:
                    columns_to_check.append(cat_col)
            
            for column in columns_to_check:
                if column not in correct_year_data or column not in agent_year_data:
                    continue
                
                total_comparisons += 1
                correct_value = correct_year_data[column]
                agent_value = agent_year_data[column]
                
                # Check if both values are valid
                if correct_value is not None and agent_value is not None:
                    diff = abs(correct_value - agent_value)
                    if diff <= tolerance:
                        successful_matches += 1
                    else:
                        failed_comparisons.append(
                            f"Year {year}, {column}: expected {correct_value:.6f}, "
                            f"got {agent_value:.6f} (diff: {diff:.6f})"
                        )
                elif correct_value is None and agent_value is None:
                    successful_matches += 1
                else:
                    failed_comparisons.append(
                        f"Year {year}, {column}: one value is None "
                        f"(expected: {correct_value}, got: {agent_value})"
                    )
        
        # Require 100% match rate
        required_match_rate = 1.0
        if total_comparisons == 0:
            return False, "no data points to compare"
        
        match_rate = successful_matches / total_comparisons
        
        print(f"\n📊 Comparison Results:")
        if categories_to_skip:
            print(f"   Skipped categories (0 weight): {categories_to_skip}")
        print(f"   Total comparisons: {total_comparisons}")
        print(f"   Successful matches: {successful_matches}")
        print(f"   Match rate: {match_rate:.2%}")
        print(f"   Required: {required_match_rate:.0%}")
        
        if match_rate < required_match_rate:
            print(f"\n❌ Failed comparisons:")
            for failure in failed_comparisons[:10]:  # Show first 10 failures
                print(f"   {failure}")
            if len(failed_comparisons) > 10:
                print(f"   ... and {len(failed_comparisons) - 10} more")
            
            return False, f"insufficient accuracy: {successful_matches}/{total_comparisons} ({match_rate:.2%}) matched, required {required_match_rate:.0%}"
        
        print(f"✅ All comparisons passed!")
        return True, None
    
    except Exception as e:
        traceback.print_exc()
        try:
            wb_agent = load_workbook(agent_growth_file, data_only=True)
            sheet = wb_agent.active
            print(f"\n--- Content of Sheet: {sheet.title} ---")
            for row in sheet.iter_rows(values_only=True):
                print(row)
        except:
            pass
        return False, f"fail to check growth rate: {str(e)}"

def parse_growth_rate(cell):
    """
    Parse growth rate from cell value.
    
    Expected format: percentage values (e.g., 5.5 means 5.5%)
    This function normalizes different input formats to percentage format.
    """
    if cell is None:
        return None
    
    if isinstance(cell, (int, float)):
        # All numeric values are expected to be in percentage format
        # e.g., 5.5 = 5.5%, -12.3 = -12.3%, 1.002 = 1.002%
        return float(cell)
    
    elif isinstance(cell, str):
        cell = cell.strip().upper()
        if cell == 'NA' or cell == '':
            return 0.0
        
        # Handle percentage strings (e.g., "5.5%")
        if cell.endswith('%'):
            try:
                return float(cell[:-1])  # Remove % and convert to number
            except ValueError:
                pass
        
        # Try to parse as plain number
        try:
            return float(cell)
        except ValueError:
            pass
    
    return None