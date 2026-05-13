#!/bin/bash
set -e

cat > /tmp/solve_diff.py << 'PYTHON_SCRIPT'
#!/usr/bin/env python3
"""
Oracle solution for pdf-excel-diff task.

Extracts table from PDF (10,500 rows), compares with Excel, and identifies differences.
"""

import json
import re
import pdfplumber
import pandas as pd
import numpy as np

PDF_FILE = "/root/employees_backup.pdf"
EXCEL_FILE = "/root/employees_current.xlsx"
OUTPUT_FILE = "/root/diff_report.json"


def convert_to_python_types(obj):
    """Convert numpy types to Python native types for JSON serialization."""
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {k: convert_to_python_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_to_python_types(item) for item in obj]
    return obj


def extract_pdf_table(pdf_path):
    """Extract employee table from large PDF (10,500+ rows)."""
    print(f"Opening PDF: {pdf_path}")

    with pdfplumber.open(pdf_path) as pdf:
        all_rows = []
        headers = None
        total_pages = len(pdf.pages)
        print(f"PDF has {total_pages} pages")

        for page_num, page in enumerate(pdf.pages):
            if page_num % 50 == 0:
                print(f"Processing page {page_num + 1}/{total_pages}...")

            tables = page.extract_tables()
            for table in tables:
                if not table:
                    continue

                for row in table:
                    # Skip empty rows
                    if not row or all(cell is None or str(cell).strip() == '' for cell in row):
                        continue

                    # Clean row
                    cleaned_row = [str(cell).strip() if cell else '' for cell in row]

                    # First row with "ID" as first column is headers
                    if headers is None and cleaned_row[0] == 'ID':
                        headers = cleaned_row
                        continue

                    # Only keep rows that start with employee ID pattern (EMP##### - 5 digits)
                    if headers and re.match(r'^EMP\d{5}$', cleaned_row[0]):
                        all_rows.append(cleaned_row)

        print(f"Extracted {len(all_rows)} data rows")

        if headers and all_rows:
            df = pd.DataFrame(all_rows, columns=headers)

            # Convert numeric columns
            numeric_cols = ['Salary', 'Years', 'Score']
            for col in numeric_cols:
                if col in df.columns:
                    df[col] = pd.to_numeric(
                        df[col].astype(str).str.replace('$', '').str.replace(',', ''),
                        errors='coerce'
                    )
            return df

    return None


def read_excel(excel_path):
    """Read current employee data from Excel."""
    print(f"Reading Excel: {excel_path}")
    df = pd.read_excel(excel_path)
    print(f"Excel has {len(df)} rows")
    return df


def compare_data(df_original, df_current):
    """Compare original (PDF) and current (Excel) data."""
    result = {
        "deleted_employees": [],
        "modified_employees": []
    }

    # Get IDs from both
    original_ids = set(df_original['ID'].tolist())
    current_ids = set(df_current['ID'].tolist())

    # Find deleted employees (in original but not in current)
    deleted_ids = original_ids - current_ids
    result["deleted_employees"] = sorted(list(deleted_ids))
    print(f"Found {len(deleted_ids)} deleted employees")

    # Find modified employees (in both, but with different values)
    common_ids = original_ids & current_ids
    print(f"Comparing {len(common_ids)} common employees...")

    # Create indexed dataframes for faster lookup
    df_orig_indexed = df_original.set_index('ID')
    df_curr_indexed = df_current.set_index('ID')

    modifications = []
    for emp_id in sorted(common_ids):
        orig_row = df_orig_indexed.loc[emp_id]
        curr_row = df_curr_indexed.loc[emp_id]

        # Compare each field
        for col in df_original.columns:
            if col == 'ID':
                continue

            orig_val = orig_row[col]
            curr_val = curr_row[col]

            # Handle NaN
            if pd.isna(orig_val) and pd.isna(curr_val):
                continue

            # Convert numpy types to Python types
            if isinstance(orig_val, (np.integer, np.floating)):
                orig_val = int(orig_val) if isinstance(orig_val, np.integer) else float(orig_val)
            if isinstance(curr_val, (np.integer, np.floating)):
                curr_val = int(curr_val) if isinstance(curr_val, np.integer) else float(curr_val)

            # Format values before comparison
            orig_formatted = orig_val
            curr_formatted = curr_val

            if isinstance(orig_formatted, float) and not pd.isna(orig_formatted):
                orig_formatted = int(orig_formatted) if orig_formatted == int(orig_formatted) else round(orig_formatted, 1)
            if isinstance(curr_formatted, float) and not pd.isna(curr_formatted):
                curr_formatted = int(curr_formatted) if curr_formatted == int(curr_formatted) else round(curr_formatted, 1)

            # Compare formatted values
            if orig_formatted != curr_formatted:
                modifications.append({
                    "id": emp_id,
                    "field": col,
                    "old_value": orig_formatted,
                    "new_value": curr_formatted
                })

    # Sort modifications by ID then field
    result["modified_employees"] = sorted(modifications, key=lambda x: (x["id"], x["field"]))
    print(f"Found {len(modifications)} modifications")

    return result


def main():
    print("=" * 60)
    print("PDF-Excel Diff Solution")
    print("=" * 60)

    print("\n[1/3] Extracting table from PDF...")
    df_original = extract_pdf_table(PDF_FILE)

    if df_original is None:
        print("ERROR: Could not extract table from PDF")
        return

    print(f"\n[2/3] Reading current Excel file...")
    df_current = read_excel(EXCEL_FILE)

    print(f"\n[3/3] Comparing data...")
    result = compare_data(df_original, df_current)

    # Convert all numpy types before serialization
    result = convert_to_python_types(result)

    with open(OUTPUT_FILE, 'w') as f:
        json.dump(result, f, indent=2)

    print(f"\n{'=' * 60}")
    print(f"Results written to {OUTPUT_FILE}")
    print(f"  - Deleted employees: {len(result['deleted_employees'])}")
    print(f"  - Modified values: {len(result['modified_employees'])}")
    print("=" * 60)


if __name__ == '__main__':
    main()
PYTHON_SCRIPT

python3 /tmp/solve_diff.py
echo "Solution complete."
