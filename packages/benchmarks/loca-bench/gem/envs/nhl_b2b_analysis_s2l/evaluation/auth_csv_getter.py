#!/usr/bin/env python3
"""
Methods for getting CSV data using Google authentication
Supports direct CSV format data retrieval from Google Sheets URLs
"""

import pandas as pd
from pathlib import Path
from typing import Optional
from google_auth_helper import GoogleSheetsAuthenticator
import io

def get_csv_with_auth(sheet_url: str, save_path: Optional[str] = None) -> Optional[pd.DataFrame]:
    """
    Get CSV data using Google authentication
    
    Args:
        sheet_url: Google Sheets URL
        save_path: optional, path to save CSV file
        
    Returns:
        DataFrame: CSV data, returns None on failure
    """
    print(f"🔑 Getting CSV data using Google authentication: {sheet_url}")
    
    try:
        # 1. Initialize authenticator
        authenticator = GoogleSheetsAuthenticator()
        
        # 2. Execute authentication
        if not authenticator.authenticate():
            print("❌ Google authentication failed")
            return None
        
        # 3. Get Sheet data
        df = authenticator.get_sheet_data(sheet_url)
        
        if df is None:
            print("❌ Cannot get Sheet data")
            return None
        
        print(f"✅ Successfully retrieved data: {len(df)} rows x {len(df.columns)} columns")
        
        # 4. Optional: save as CSV file
        if save_path:
            df.to_csv(save_path, index=False)
            print(f"💾 CSV saved to: {save_path}")
        
        return df
        
    except Exception as e:
        print(f"❌ Failed to get CSV data: {e}")
        return None

def get_csv_as_string(sheet_url: str) -> Optional[str]:
    """
    Get CSV format string data
    
    Args:
        sheet_url: Google Sheets URL
        
    Returns:
        str: CSV string, returns None on failure
    """
    try:
        df = get_csv_with_auth(sheet_url)
        if df is not None:
            # Convert to CSV string
            csv_string = df.to_csv(index=False)
            return csv_string
        return None
        
    except Exception as e:
        print(f"❌ Failed to convert CSV string: {e}")
        return None

def get_csv_for_evaluation(sheet_url: str) -> Optional[pd.DataFrame]:
    """
    CSV acquisition method specifically designed for evaluation system
    Includes data validation and cleaning
    
    Args:
        sheet_url: Google Sheets URL
        
    Returns:
        DataFrame: cleaned CSV data
    """
    try:
        # Get raw data
        df = get_csv_with_auth(sheet_url)
        
        if df is None:
            return None
        
        # Data cleaning
        print("🧹 Performing data cleaning...")
        
        # Remove completely empty rows
        df = df.dropna(how='all')
        
        # Remove unnamed columns
        df = df.loc[:, ~df.columns.str.contains('^Unnamed')]
        
        # Remove extra spaces from column names and data
        df.columns = df.columns.str.strip()
        df = df.applymap(lambda x: x.strip() if isinstance(x, str) else x)
        
        print(f"✅ Data cleaning completed: {len(df)} rows x {len(df.columns)} columns")
        
        return df
        
    except Exception as e:
        print(f"❌ Failed to get CSV for evaluation: {e}")
        return None

def compare_with_standard_csv(agent_sheet_url: str, standard_csv_path: str) -> tuple[bool, str]:
    """
    Compare Agent's Google Sheet with standard CSV
    
    Args:
        agent_sheet_url: Google Sheet URL created by Agent
        standard_csv_path: path to standard answer CSV file
        
    Returns:
        tuple: (comparison result, detailed information)
    """
    try:
        print("🔍 Starting CSV comparison...")
        
        # 1. Get Agent's Sheet data
        agent_df = get_csv_for_evaluation(agent_sheet_url)
        if agent_df is None:
            return False, "Cannot get Agent's Sheet data"
        
        # 2. Read standard answer
        standard_df = pd.read_csv(standard_csv_path)
        print(f"📊 Standard answer: {len(standard_df)} rows x {len(standard_df.columns)} columns")
        
        # 3. Basic structure comparison
        if len(agent_df.columns) != len(standard_df.columns):
            return False, f"Column count mismatch: Agent({len(agent_df.columns)}) vs Standard({len(standard_df.columns)})"
        
        if len(agent_df) != len(standard_df):
            return False, f"Row count mismatch: Agent({len(agent_df)}) vs Standard({len(standard_df)})"
        
        # 4. Column name comparison
        agent_cols = set(agent_df.columns)
        standard_cols = set(standard_df.columns)
        
        if agent_cols != standard_cols:
            missing = standard_cols - agent_cols
            extra = agent_cols - standard_cols
            details = []
            if missing:
                details.append(f"Missing columns: {missing}")
            if extra:
                details.append(f"Extra columns: {extra}")
            return False, f"Column names mismatch: {'; '.join(details)}"
        
        # 5. Data content comparison (simplified version)
        try:
            # Sort by column name to ensure consistency
            agent_sorted = agent_df.sort_values(agent_df.columns[0]).reset_index(drop=True)
            standard_sorted = standard_df.sort_values(standard_df.columns[0]).reset_index(drop=True)
            
            # Compare column by column
            mismatches = []
            for col in agent_df.columns:
                if not agent_sorted[col].equals(standard_sorted[col]):
                    mismatches.append(col)
            
            if mismatches:
                return False, f"Data mismatched columns: {mismatches[:3]}{'...' if len(mismatches) > 3 else ''}"
            
            return True, f"✅ CSV data completely matches: {len(agent_df)} rows x {len(agent_df.columns)} columns"
            
        except Exception as e:
            return False, f"Data comparison failed: {e}"
        
    except Exception as e:
        return False, f"CSV comparison error: {e}"

# Usage example
def example_usage():
    """Usage example"""
    print("📝 Google Authentication CSV Retrieval Example")
    print("=" * 50)
    
    # Example 1: Basic retrieval
    test_url = "https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit"
    
    print("\n1️⃣ Basic retrieval:")
    df = get_csv_with_auth(test_url)
    
    print("\n2️⃣ Get CSV string:")
    csv_str = get_csv_as_string(test_url)
    if csv_str:
        print(f"CSV string length: {len(csv_str)} characters")
    
    print("\n3️⃣ Evaluation retrieval:")
    clean_df = get_csv_for_evaluation(test_url)
    
    print("\n4️⃣ Compare with standard answer:")
    success, msg = compare_with_standard_csv(test_url, "standard_answer.csv")
    print(f"Comparison result: {msg}")

if __name__ == "__main__":
    example_usage() 