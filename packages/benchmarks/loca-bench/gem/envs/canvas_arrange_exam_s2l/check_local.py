from argparse import ArgumentParser
import asyncio
import re
from datetime import datetime, timedelta

import subprocess
import os
import json
import pandas as pd

from helper import normalize_str

def check_time_order(df_agent):
    """
    Check if exam time order is correct (arranged from nearest to farthest, TBD at the end)

    Returns:
        (is_valid, error_message)
    """
    if len(df_agent) == 0:
        return True, None
    
    try:
        prev_datetime = None
        tbd_encountered = False
        
        for idx, row in df_agent.iterrows():
            date_str = str(row.get('Final Date (MM/DD/YYYY)', '')).strip()
            time_str = str(row.get('Start Time (HH:MM)', '')).strip()
            course_code = row.get('Course Code', 'Unknown')
            
            # Check if it's TBD
            if date_str.upper() == 'TBD' or time_str.upper() == 'TBD' or date_str == 'nan' or time_str == 'nan':
                tbd_encountered = True
                continue

            # If TBD was encountered before and now we encounter non-TBD, the order is wrong
            if tbd_encountered:
                return False, f"Time order error: TBD exams must be at the end, but a TBD exam was found before {course_code}"

            # Parse date and time
            try:
                # Parse MM/DD/YYYY format
                date_parts = date_str.split('/')
                if len(date_parts) != 3:
                    return False, f"Date format error: date '{date_str}' for {course_code} is not in MM/DD/YYYY format"

                month, day, year = date_parts

                # Parse HH:MM format
                time_parts = time_str.split(':')
                if len(time_parts) != 2:
                    return False, f"Time format error: time '{time_str}' for {course_code} is not in HH:MM format"

                hour, minute = time_parts

                # Create datetime object
                current_datetime = datetime(int(year), int(month), int(day), int(hour), int(minute))

                # Check order (should be ascending, i.e., from nearest to farthest)
                if prev_datetime is not None:
                    if current_datetime < prev_datetime:
                        return False, f"Time order error: exam time for {course_code} ({date_str} {time_str}) should be after the previous exam"

                prev_datetime = current_datetime

            except (ValueError, IndexError) as e:
                return False, f"Date/time parsing error: {course_code} - {str(e)}"

        return True, None

    except Exception as e:
        return False, f"Error checking time order: {str(e)}"

def check_local(agent_workspace: str, groundtruth_workspace: str):
    """
    Compare contents of two CSV files to check if they are identical.
    Returns (True, None) if contents are identical, otherwise returns (False, 'File contents do not match').
    """
    agent_needed_file = os.path.join(agent_workspace,"exam_schedule.xlsx")
    groundtruth_needed_file = os.path.join(groundtruth_workspace,"exam_schedule.xlsx")

    # Check if files exist
    if not os.path.exists(agent_needed_file):
        return False, f'Agent workspace file does not exist: {agent_needed_file}'

    if not os.path.exists(groundtruth_needed_file):
        return False, f'Ground truth workspace file does not exist: {groundtruth_needed_file}'

    try:
        # Read both xlsx files
        print("agent_needed_file: ", agent_needed_file)
        df_agent = pd.read_excel(agent_needed_file, engine='openpyxl')
        df_ground = pd.read_excel(groundtruth_needed_file, engine='openpyxl')

        # First check time order
        print("\n⏰ Checking time order...")
        time_order_valid, time_order_error = check_time_order(df_agent)
        if not time_order_valid:
            print(f"❌ Time order check failed: {time_order_error}")
            return False, f"Time order error: {time_order_error}"
        else:
            print("✅ Time order is correct (arranged from nearest to farthest, TBD at the end)")

        # Define key columns to compare, which is all columns
        key_columns = ['Course Code', 'Course Name', 'Proctor Name', 'Proctor Email', 'Open-book/Closed-book', 'Final Date (MM/DD/YYYY)', 'Start Time (HH:MM)', 'Duration (minutes)', 'Location', 'Information Source(Announcement/Email/Message)', 'Course Credit']
        
        print(f"Agent output rows: {len(df_agent)}")
        print(f"Ground truth rows: {len(df_ground)}")
        
        # Numeric comparison function
        def compare_numeric_values(agent_val, ground_val):
            """
            Compare numeric fields like Course Credit
            Handle cases like '4.0' and '4' being numerically equal but different as strings
            """
            try:
                # Try to convert to float for comparison
                agent_num = float(str(agent_val).strip())
                ground_num = float(str(ground_val).strip())
                return agent_num == ground_num
            except (ValueError, TypeError):
                # If cannot convert to number, compare as strings
                return str(agent_val).strip() == str(ground_val).strip()

        # String tolerant comparison function
        def compare_strings_tolerant(agent_val, ground_val, field_name):
            """
            More lenient string comparison that tolerates the following cases:
            1. Ground truth is a substring of agent value (e.g., 'emily' matches 'emily davis')
            2. Aliases for Information Source (e.g., 'announcement' matches 'canvas announcement')
            """
            agent_str = str(agent_val).strip().lower()
            ground_str = str(ground_val).strip().lower()

            # Exact match
            if agent_str == ground_str:
                return True

            # For Proctor Name field, check if ground truth is part of agent value
            # For example: 'emily' should match 'emily davis'
            if field_name == 'Proctor Name':
                # Split into words for comparison
                agent_words = set(agent_str.split())
                ground_words = set(ground_str.split())
                # If all words in ground truth appear in agent, consider it a match
                if ground_words.issubset(agent_words):
                    return True

            # For Information Source field, handle aliases
            if field_name == 'Information Source(Announcement/Email/Message)':
                # Normalize source type
                def normalize_source(s):
                    s = s.lower().strip()
                    # Remove 'canvas' prefix
                    s = s.replace('canvas ', '').replace('canvas', '')
                    s = s.strip()
                    return s

                agent_source = normalize_source(agent_str)
                ground_source = normalize_source(ground_str)

                if agent_source == ground_source:
                    return True

            # Check if ground truth is a substring of agent
            if ground_str in agent_str:
                return True

            # Check if agent is a substring of ground truth (reverse check)
            if agent_str in ground_str:
                return True

            return False

        # First check if row counts match
        if len(df_agent) != len(df_ground):
            error_msg = f"Row count mismatch: Agent has {len(df_agent)} courses, Ground truth has {len(df_ground)} courses"
            print(f"❌ {error_msg}")
            return False, error_msg

        # Match and compare by course code
        matches = 0
        total_courses = len(df_ground)  # Use groundtruth row count as total
        differences = []
        missing_in_agent = []

        # First check if each course in groundtruth exists in agent
        for idx_ground, row_ground in df_ground.iterrows():
            course_code_ground = row_ground['Course Code']
            matching_rows_agent = df_agent[df_agent['Course Code'] == course_code_ground]

            if matching_rows_agent.empty:
                missing_in_agent.append(course_code_ground)
                differences.append(f"❌ Course {course_code_ground} not found in agent output (required course missing)")

        # If courses from groundtruth are missing in agent, return failure
        if missing_in_agent:
            error_msg = f"Agent output is missing {len(missing_in_agent)} required courses: {', '.join(missing_in_agent)}"
            print(f"❌ {error_msg}")
            for diff in differences:
                print(f"  - {diff}")
            return False, error_msg

        # Iterate through each course in groundtruth and check if the corresponding course in agent fully matches
        for idx_ground, row_ground in df_ground.iterrows():
            course_code_ground = row_ground['Course Code']

            # Find the corresponding course in agent output
            matching_rows_agent = df_agent[df_agent['Course Code'] == course_code_ground]

            # Take the first matching row
            row_agent = matching_rows_agent.iloc[0]

            # Compare key columns
            course_matches = True
            course_diffs = []

            for col in key_columns:
                val_agent = row_agent.get(col, 'N/A')
                val_ground = row_ground.get(col, 'N/A')

                # Normalize values for comparison
                val_agent_norm = normalize_str(str(val_agent)) if pd.notna(val_agent) else 'TBD'
                val_agent_norm = val_agent_norm.replace('professor','') # for professor smith
                val_ground_norm = normalize_str(str(val_ground)) if pd.notna(val_ground) else 'TBD'

                if col == 'Course Credit':
                    # Use numeric comparison for Course Credit
                    is_match = compare_numeric_values(val_agent_norm, val_ground_norm)
                    if not is_match:
                        course_matches = False
                        course_diffs.append(f"{col}: Agent='{val_agent_norm}' vs Ground='{val_ground_norm}'")
                else:
                    # Other columns use tolerant string comparison
                    is_match = compare_strings_tolerant(val_agent_norm, val_ground_norm, col)
                    if not is_match:
                        course_matches = False
                        course_diffs.append(f"{col}: Agent='{val_agent_norm}' vs Ground='{val_ground_norm}'")
            
            if course_matches:
                matches += 1
                print(f"✅ {course_code_ground}: Fully matched")
            else:
                differences.append(f"❌ {course_code_ground}: {'; '.join(course_diffs)}")

        # Check if agent has extra courses not in groundtruth
        extra_courses = []
        for idx_agent, row_agent in df_agent.iterrows():
            course_code_agent = row_agent['Course Code']
            if not any(df_ground['Course Code'] == course_code_agent):
                extra_courses.append(course_code_agent)
                differences.append(f"⚠️  Course {course_code_agent} not found in ground truth (extra course)")

        # Calculate match rate (based on groundtruth course count)
        if total_courses > 0:
            match_rate = matches / total_courses
        else:
            match_rate = 0

        print(f"\n📊 Comparison results:")
        print(f"Ground truth total courses: {total_courses}")
        print(f"Agent output total courses: {len(df_agent)}")
        print(f"Fully matched courses: {matches}/{total_courses} ({match_rate:.1%})")

        if extra_courses:
            print(f"⚠️  Agent output has {len(extra_courses)} extra courses (not in ground truth)")

        if differences:
            print(f"\n❌ Found {len(differences)} differences:")
            for diff in differences[:10]:  # Only show first 10 differences
                print(f"  - {diff}")
            if len(differences) > 10:
                print(f"  ... and {len(differences) - 10} more differences")

        # Must satisfy: 1) 100% match rate  2) No extra courses
        if match_rate >= 1.0 and len(extra_courses) == 0:
            print("✅ File contents are identical (all ground truth courses matched, no extra courses)")
            return True, None
        else:
            if match_rate < 1.0:
                error_msg = f'Insufficient match rate: {match_rate:.1%}, number of differences: {len(differences)}'
            else:
                error_msg = f'Agent output contains {len(extra_courses)} extra courses'
            print(f"❌ {error_msg}")
            return False, error_msg

    except Exception as e:
        return False, f'Error reading xlsx file: {str(e)}'



