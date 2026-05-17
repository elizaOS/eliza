from argparse import ArgumentParser
import asyncio
import re
from datetime import datetime, timedelta

import subprocess
import os
import json
import pandas as pd
import numpy as np


def normalize_str(xstring):
    """Normalize string by removing punctuation and whitespace and lowercase"""
    return re.sub(r'[^\w]', '', xstring).lower().strip()

def compare_csv_files(agent_file, groundtruth_file, file_type, key_columns):
    """
    Comprehensive CSV file comparison function, including the following checks:
    1. File existence check
    2. Column completeness check (key columns cannot be missing)
    3. Row count consistency check
    4. Order consistency check
    5. Complete content match check (including course code suffixes)
    6. Data type consistency check
    """
    # Check if files exist
    if not os.path.exists(agent_file):
        return False, f'{file_type} file does not exist: {agent_file}'

    if not os.path.exists(groundtruth_file):
        return False, f'Groundtruth file does not exist: {groundtruth_file}'

    try:
        # Read CSV files
        print(f"\n[CHECK] Checking {file_type} file:")
        print(f"  Agent file: {agent_file}")
        print(f"  Groundtruth file: {groundtruth_file}")

        df_agent = pd.read_csv(agent_file)
        df_ground = pd.read_csv(groundtruth_file)

        print(f"  Agent rows: {len(df_agent)}")
        print(f"  Groundtruth rows: {len(df_ground)}")

        # ============ 1. Column completeness check ============
        print("\n[STEP1] Column completeness check")
        agent_columns = set(df_agent.columns)
        ground_columns = set(df_ground.columns)

        # Check if key columns exist
        missing_key_columns_agent = []
        missing_key_columns_ground = []

        for col in key_columns:
            if col not in agent_columns:
                missing_key_columns_agent.append(col)
            if col not in ground_columns:
                missing_key_columns_ground.append(col)

        if missing_key_columns_agent:
            error_msg = f'Agent file missing key columns: {", ".join(missing_key_columns_agent)}'
            print(f"  [FAIL] {error_msg}")
            return False, error_msg

        if missing_key_columns_ground:
            error_msg = f'Groundtruth file missing key columns: {", ".join(missing_key_columns_ground)}'
            print(f"  [FAIL] {error_msg}")
            return False, error_msg

        # Check if column sets are completely identical
        if agent_columns != ground_columns:
            extra_in_agent = agent_columns - ground_columns
            missing_in_agent = ground_columns - agent_columns

            error_parts = []
            if extra_in_agent:
                error_parts.append(f"Agent extra columns: {', '.join(extra_in_agent)}")
                print(f"  [WARN] {error_parts[-1]}")
            if missing_in_agent:
                error_parts.append(f"Agent missing columns: {', '.join(missing_in_agent)}")
                print(f"  [WARN] {error_parts[-1]}")

            return False, f'Column mismatch - {"; ".join(error_parts)}'

        print(f"  [PASS] Column completeness check passed ({len(agent_columns)} columns)")

        # ============ 2. Row count consistency check ============
        print("\n[STEP2] Row count consistency check")
        if len(df_agent) != len(df_ground):
            error_msg = f'Row count mismatch: Agent={len(df_agent)}, Groundtruth={len(df_ground)}'
            print(f"  [FAIL] {error_msg}")
            return False, error_msg

        print(f"  [PASS] Row count consistent ({len(df_agent)} rows)")

        # ============ 3. Order consistency check ============
        print("\n[STEP3] Order consistency check")
        order_matches = True
        order_differences = []

        # Use course_code as primary key for order checking
        if 'course_code' in df_agent.columns:
            for idx in range(len(df_agent)):
                agent_code = str(df_agent.iloc[idx]['course_code'])
                ground_code = str(df_ground.iloc[idx]['course_code'])

                if agent_code != ground_code:
                    order_matches = False
                    order_differences.append(f"Row {idx+1}: Agent='{agent_code}' vs Groundtruth='{ground_code}'")
                    if len(order_differences) >= 5:  # Only record first 5 differences
                        order_differences.append("...")
                        break

        if not order_matches:
            print(f"  [WARN] Order mismatch, first few differences:")
            for diff in order_differences[:5]:
                print(f"    - {diff}")
        else:
            print(f"  [PASS] Row order completely consistent")

        # ============ 4. Data type consistency check ============
        print("\n[STEP4] Data type consistency check")
        dtype_issues = []

        for col in df_agent.columns:
            agent_dtype = df_agent[col].dtype
            ground_dtype = df_ground[col].dtype

            # Check if basic data types are compatible
            if agent_dtype != ground_dtype:
                # Allow conversion between int64 and float64 (if values are equal)
                if pd.api.types.is_numeric_dtype(agent_dtype) and pd.api.types.is_numeric_dtype(ground_dtype):
                    continue
                dtype_issues.append(f"{col}: Agent={agent_dtype} vs Groundtruth={ground_dtype}")

        if dtype_issues:
            print(f"  [WARN] Data type differences found:")
            for issue in dtype_issues:
                print(f"    - {issue}")
        else:
            print(f"  [PASS] Data types consistent")

        # ============ 5. Complete content match check ============
        print("\n[STEP5] Complete content match check")

        # Function to normalize datetime format
        def normalize_datetime(datetime_str):
            try:
                if pd.isna(datetime_str) or str(datetime_str).strip() in ['TBD', 'N/A', '']:
                    return 'TBD'

                datetime_str = str(datetime_str).strip()

                # Try to parse ISO format datetime
                if 'T' in datetime_str and 'Z' in datetime_str:
                    try:
                        dt = datetime.fromisoformat(datetime_str.replace('Z', '+00:00'))
                        return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
                    except:
                        pass

                return datetime_str
            except:
                return str(datetime_str)

        # Numeric comparison function
        def compare_numeric_values(agent_val, ground_val):
            """Compare numeric fields, handling cases like '4.0' and '4' which are numerically equal but string-different"""
            try:
                # Handle NaN
                if pd.isna(agent_val) and pd.isna(ground_val):
                    return True
                if pd.isna(agent_val) or pd.isna(ground_val):
                    return False

                # Try to convert to float for comparison
                agent_num = float(str(agent_val).strip())
                ground_num = float(str(ground_val).strip())

                # Use numpy's approximate equality comparison, allowing floating point error
                return np.isclose(agent_num, ground_num, rtol=1e-9, atol=1e-9)
            except (ValueError, TypeError):
                # If cannot convert to number, compare as strings
                return str(agent_val).strip() == str(ground_val).strip()

        # String comparison function
        def compare_string_values(agent_val, ground_val, strict=True, is_course_name=False):
            """
            Compare string fields
            strict=True: Exact match (for course_code etc.)
            strict=False: Smart match using normalize_str
            is_course_name: If course_name field, ignore trailing -1 suffix
            """
            if pd.isna(agent_val) and pd.isna(ground_val):
                return True
            if pd.isna(agent_val) or pd.isna(ground_val):
                return False

            agent_str = str(agent_val).strip()
            ground_str = str(ground_val).strip()

            # If course_name field, remove trailing numeric suffix (like -1, -2, -3 etc.) for comparison
            if is_course_name:
                agent_str = re.sub(r'-\d+$', '', agent_str)
                ground_str = re.sub(r'-\d+$', '', ground_str)

            if strict:
                # Strict match mode: exactly equal
                return agent_str == ground_str
            else:
                # Smart match mode: use normalize_str
                agent_normalized = normalize_str(agent_str)
                ground_normalized = normalize_str(ground_str)
                return agent_normalized == ground_normalized

        # Define field types based on file type
        if file_type == "quiz_info":
            numeric_columns = ['credits', 'number_of_questions', 'time_limit', 'allowed_attempts', 'points_possible']
            string_columns = ['quiz_title', 'course_name']
            datetime_columns = ['deadline']
            strict_columns = ['course_code']  # Columns requiring strict match
        else:  # assignment_info
            numeric_columns = ['points_possible']
            string_columns = ['assignment_title', 'course_name']
            datetime_columns = ['deadline']
            strict_columns = ['course_code']  # Columns requiring strict match

        # Compare row by row, column by column
        content_matches = True
        content_differences = []
        row_match_count = 0

        for idx in range(len(df_agent)):
            row_matches = True
            row_diffs = []

            for col in key_columns:
                if col not in df_agent.columns:
                    continue

                val_agent = df_agent.iloc[idx][col]
                val_ground = df_ground.iloc[idx][col]

                is_match = False

                # Choose comparison method based on column type
                if col in strict_columns:
                    # Strict match (like course_code, keeping -1 suffix)
                    is_match = compare_string_values(val_agent, val_ground, strict=True)
                elif col in numeric_columns:
                    is_match = compare_numeric_values(val_agent, val_ground)
                elif col in datetime_columns:
                    val_agent_norm = normalize_datetime(val_agent)
                    val_ground_norm = normalize_datetime(val_ground)
                    is_match = val_agent_norm == val_ground_norm
                elif col in string_columns:
                    # Special handling for course_name field, ignoring -1 suffix
                    is_course_name = (col == 'course_name')
                    is_match = compare_string_values(val_agent, val_ground, strict=False, is_course_name=is_course_name)
                else:
                    # Default to strict string comparison
                    is_match = compare_string_values(val_agent, val_ground, strict=True)

                if not is_match:
                    row_matches = False
                    row_diffs.append(f"{col}: '{val_agent}' vs '{val_ground}'")

            if row_matches:
                row_match_count += 1
            else:
                content_matches = False
                course_code = df_agent.iloc[idx].get('course_code', f'Row {idx+1}')
                content_differences.append(f"Row {idx+1} ({course_code}): {'; '.join(row_diffs)}")

        print(f"  Matching rows: {row_match_count}/{len(df_agent)}")

        if not content_matches:
            print(f"  [FAIL] Content not fully matching, difference details:")
            for i, diff in enumerate(content_differences[:10]):  # Show first 10 differences
                print(f"    {i+1}. {diff}")
            if len(content_differences) > 10:
                print(f"    ... {len(content_differences)-10} more differences")
        else:
            print(f"  [PASS] Content fully matches")

        # ============ 6. Final verdict ============
        print("\n[RESULT] Final verdict:")

        # Collect all issues
        all_issues = []

        if not order_matches:
            all_issues.append("Order mismatch")

        if dtype_issues:
            all_issues.append(f"Data type differences ({len(dtype_issues)} issues)")

        if not content_matches:
            all_issues.append(f"Content differences ({len(content_differences)} issues)")

        if len(all_issues) == 0:
            print(f"[PASS] {file_type} file completely consistent!")
            return True, None
        else:
            error_msg = f'{file_type} check failed: {"; ".join(all_issues)}'
            print(f"[FAIL] {error_msg}")
            return False, error_msg

    except Exception as e:
        error_msg = f'{file_type} file processing exception: {str(e)}'
        print(f"[ERROR] {error_msg}")
        import traceback
        traceback.print_exc()
        return False, error_msg


def check_local(agent_workspace: str, groundtruth_workspace: str):
    """
    Comprehensively compare CSV files in two workspaces, performing strict consistency checks.

    Check items:
    1. File existence
    2. Column completeness (all key columns must exist)
    3. Row count consistency
    4. Order consistency (by course_code order)
    5. Complete content match (including course_code suffixes)
    6. Data type consistency
    """

    print("=" * 60)
    print("[START] Beginning comprehensive CSV file consistency check")
    print("=" * 60)

    # Define files to check and their corresponding key fields
    files_to_check = [
        {
            'filename': 'quiz_info.csv',
            'key_columns': ['course_code', 'credits', 'quiz_title', 'number_of_questions',
                          'time_limit', 'allowed_attempts', 'points_possible',
                          'deadline', 'course_name']
        },
        {
            'filename': 'assignment_info.csv',
            'key_columns': ['course_code', 'assignment_title', 'deadline', 'course_name', 'points_possible']
        }
    ]

    overall_success = True
    all_errors = []

    # Check each file one by one
    for i, file_info in enumerate(files_to_check, 1):
        filename = file_info['filename']
        key_columns = file_info['key_columns']
        file_type = filename.replace('.csv', '')

        print(f"\n{'='*60}")
        print(f"[FILE {i}]: {filename}")
        print(f"{'='*60}")

        agent_file = os.path.join(agent_workspace, filename)
        groundtruth_file = os.path.join(groundtruth_workspace, filename)

        success, error = compare_csv_files(agent_file, groundtruth_file, file_type, key_columns)

        if not success:
            overall_success = False
            all_errors.append(f"{filename}: {error}")

    # Output final result
    print("\n" + "=" * 60)
    print("[SUMMARY] Overall check result")
    print("=" * 60)

    if overall_success:
        print("\n[SUCCESS] All checks passed!")
        print("  [PASS] File completeness: Passed")
        print("  [PASS] Column completeness: Passed")
        print("  [PASS] Row count consistency: Passed")
        print("  [PASS] Order consistency: Passed")
        print("  [PASS] Content match: Passed")
        print("  [PASS] Data type: Passed")
        return True, None
    else:
        combined_error = "\n".join(all_errors)
        print(f"\n[FAIL] Check failed, issue summary:")
        for i, error in enumerate(all_errors, 1):
            print(f"  {i}. {error}")
        return False, combined_error


# Test entry point
if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        print("Usage: python check_local.py <agent_workspace> <groundtruth_workspace>")
        sys.exit(1)

    agent_ws = sys.argv[1]
    ground_ws = sys.argv[2]

    success, error = check_local(agent_ws, ground_ws)

    if not success:
        print(f"\nFinal result: Failed")
        print(f"Error message: {error}")
        sys.exit(1)
    else:
        print(f"\nFinal result: Success")
        sys.exit(0)
