import os
import sys
import json
import re
import requests
import pandas as pd
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from io import StringIO

GOOGLE_API_AVAILABLE = False
from mcp_convert.mcps.google_sheet.database_utils import GoogleSheetDatabase

def authenticate_google_services():
    """Authenticate Google services - using OAuth2 user credentials"""
    try:
        # Get credentials path - search upward from current directory
        current_path = Path(__file__).parent
        credentials_path = None

        # Try different levels of upward search
        for levels in range(1, 7):  # Maximum 6 levels up
            test_root = current_path
            for _ in range(levels):
                test_root = test_root.parent

            test_path = test_root / "configs" / "google_credentials.json"
            if test_path.exists():
                credentials_path = str(test_path)
                break

        if not credentials_path:
            # Default path if not found
            default_path = current_path.parent.parent.parent.parent / "configs" / "google_credentials.json"
            credentials_path = str(default_path)

        # Read OAuth2 credentials file
        with open(credentials_path, 'r') as f:
            creds_data = json.load(f)

        SCOPES = [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/spreadsheets'
        ]

        # Create OAuth2 credentials object
        credentials = Credentials(
            token=creds_data.get('token'),
            refresh_token=creds_data.get('refresh_token'),
            token_uri=creds_data.get('token_uri'),
            client_id=creds_data.get('client_id'),
            client_secret=creds_data.get('client_secret'),
            scopes=creds_data.get('scopes', SCOPES)
        )

        # If token expired, refresh automatically
        if credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())

            # Update and save the token
            creds_data['token'] = credentials.token
            with open(credentials_path, 'w') as f:
                json.dump(creds_data, f, indent=2)

        # Initialize gspread client
        gc = gspread.authorize(credentials)

        # Initialize Google Drive API client
        drive_service = build('drive', 'v3', credentials=credentials)

        return gc, drive_service

    except FileNotFoundError:
        raise Exception(f"Error: Credentials file not found '{credentials_path}'")
    except json.JSONDecodeError:
        raise Exception(f"Error: Credentials file format error '{credentials_path}'")
    except Exception as e:
        raise Exception(f"Google services authentication failed: {e}")

def find_spreadsheet_in_folder(agent_workspace: str, spreadsheet_name: str = "NHL-B2B-Analysis") -> str:
    """
    Find Spreadsheet file in the folder specified by agent workspace
    Prioritize reading folder ID from folder_id.txt for search
    """
    workspace_path = Path(agent_workspace)

    # Method 1: Read folder ID from folder_id.txt
    folder_id_path = "tasks/finalpool/NHL-B2B-Analysis/files/folder_id.txt"
    target_folder_id = None

    try:
        with open(folder_id_path, 'r') as f:
            target_folder_id = f.read().strip()
        print(f"🔍 Read folder ID from folder_id.txt: {target_folder_id}")
    except Exception as e:
        print(f"⚠️ Failed to read folder_id.txt: {e}")

    if target_folder_id:
        # Search using folder ID
        try:
            gc, drive_service = authenticate_google_services()

            # Query for Spreadsheet file with specified name in folder
            query = f"'{target_folder_id}' in parents and name='{spreadsheet_name}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
            results = drive_service.files().list(
                q=query,
                fields="files(id, name, mimeType)"
            ).execute()

            files = results.get('files', [])
            if not files:
                # If file with specified name not found, try to find any spreadsheet file
                fallback_query = f"'{target_folder_id}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
                fallback_results = drive_service.files().list(
                    q=fallback_query,
                    fields="files(id, name, mimeType)"
                ).execute()

                fallback_files = fallback_results.get('files', [])
                if not fallback_files:
                    raise Exception(f"No Google Spreadsheet files found in folder")

                # Return the first spreadsheet found
                spreadsheet = fallback_files[0]
                return spreadsheet['id']
            else:
                # Return the spreadsheet ID with specified name
                spreadsheet = files[0]
                return spreadsheet['id']

        except Exception as e:
            raise Exception(f"Failed to find spreadsheet by folder ID: {str(e)}")

    # Method 2: Read URL from google_sheet_url.json
    json_file_path = workspace_path / "google_sheet_url.json"

    try:
        if json_file_path.exists():
            with open(json_file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            sheet_url = data.get('google_sheet_url')

            if sheet_url and isinstance(sheet_url, str):
                if 'docs.google.com/spreadsheets' in sheet_url:
                    # Extract sheet ID from URL
                    sheet_id = extract_sheet_id(sheet_url)
                    if sheet_id:
                        return sheet_id
                    else:
                        raise Exception(f"Cannot extract sheet ID from URL: {sheet_url}")
                else:
                    raise Exception(f"Incorrect URL format: {sheet_url}")
            else:
                raise Exception("Valid google_sheet_url field not found")
        else:
            raise Exception(f"google_sheet_url.json file not found: {json_file_path}")

    except json.JSONDecodeError as e:
        raise Exception(f"JSON file format error: {e}")
    except Exception as e:
        raise Exception(f"Failed to find spreadsheet: {e}")

def extract_sheet_id(url: str) -> Optional[str]:
    """Extract Sheet ID from Google Sheets URL"""
    patterns = [
        r'/spreadsheets/d/([a-zA-Z0-9-_]+)',
        r'spreadsheets/d/([a-zA-Z0-9-_]+)'
    ]

    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)

    return None

def fetch_google_sheet_data_gspread(sheet_id: str) -> Optional[pd.DataFrame]:
    """
    Get Google Sheet data using gspread
    """
    try:
        gc, drive_service = authenticate_google_services()
        spreadsheet = gc.open_by_key(sheet_id)

        # Get the first worksheet
        worksheet = spreadsheet.get_worksheet(0)
        if not worksheet:
            raise Exception("No worksheets found in spreadsheet")

        # Get all data
        values = worksheet.get_all_values()

        if len(values) < 2:
            raise Exception("Sheet data insufficient (needs at least header row and one data row)")

        # Convert to DataFrame
        df = pd.DataFrame(values[1:], columns=values[0])

        # Basic data cleaning
        df = df.dropna(how='all')  # Remove completely empty rows

        return df

    except Exception as e:
        raise Exception(f"Failed to get Google Sheet data: {e}")

def check_sheet_comparison(agent_workspace: str, groundtruth_workspace: str) -> Tuple[bool, str]:
    """
    Compare Agent output data with standard answers using gspread
    Supports three comparison methods (all must pass):
    1. Local CSV file comparison (vs standard answer)
    2. Google Sheet remote comparison (vs standard answer)
    3. CSV vs Google Sheet consistency check (NEW!)

    Args:
        agent_workspace: agent workspace path
        groundtruth_workspace: groundtruth workspace path

    Returns:
        tuple: (whether check passed, check information)
    """

    try:
        # Execute three comparison methods
        local_csv_result = try_local_csv_comparison(agent_workspace, groundtruth_workspace)
        remote_sheet_result = try_remote_sheet_comparison(agent_workspace, groundtruth_workspace)
        
        # NEW: Check CSV vs Google Sheet consistency
        consistency_result = try_csv_sheet_consistency_check(agent_workspace, groundtruth_workspace)

        # Check if all methods passed
        all_passed = local_csv_result[0] and remote_sheet_result[0] and consistency_result[0]

        if all_passed:
            # All checks passed
            success_details = []
            success_details.append("✅ All data comparison methods succeeded:")
            success_details.append(f"   - Local CSV vs Standard: {local_csv_result[1]}")
            success_details.append(f"   - Google Sheet vs Standard: {remote_sheet_result[1]}")
            success_details.append(f"   - CSV vs Sheet Consistency: {consistency_result[1]}")

            return True, "\n".join(success_details)
        else:
            # Some checks failed
            error_details = []
            error_details.append("❌ Some data comparison methods failed (all required to pass):")
            error_details.append(f"   - Local CSV vs Standard: {'✅' if local_csv_result[0] else '❌'} {local_csv_result[1]}")
            error_details.append(f"   - Google Sheet vs Standard: {'✅' if remote_sheet_result[0] else '❌'} {remote_sheet_result[1]}")
            error_details.append(f"   - CSV vs Sheet Consistency: {'✅' if consistency_result[0] else '❌'} {consistency_result[1]}")

            return False, "\n".join(error_details)

    except Exception as e:
        return False, f"Sheet comparison check error: {str(e)}"

def try_local_csv_comparison(agent_workspace: str, groundtruth_workspace: str) -> Tuple[bool, str]:
    """Try local CSV file comparison"""
    try:
        # 1. Load standard answer CSV
        standard_csv_path = Path(groundtruth_workspace) / "standard_answer.csv"
        if not standard_csv_path.exists():
            return False, "Standard answer CSV file does not exist"

        standard_data = pd.read_csv(standard_csv_path)

        # 2. Find Agent output data (csv)
        agent_data = find_agent_csv_output_data(agent_workspace)
        if agent_data is None:
            return False, "Agent output data not found"

        # 3. Perform data comparison
        comparison_passed, comparison_msg = compare_dataframes(standard_data, agent_data, "Local CSV comparison")

        return comparison_passed, comparison_msg

    except Exception as e:
        return False, f"Local CSV comparison failed: {str(e)}"

def fetch_google_sheet_data_from_local_db(agent_workspace: str, spreadsheet_id: str) -> Optional[pd.DataFrame]:
    """
    Read Google Sheet data from local database
    Read the nhl_b2b_analysis output spreadsheet created by agent
    """
    try:
        # Get database directory
        workspace_parent = Path(agent_workspace).parent
        google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
        
        if not Path(google_sheet_db_dir).exists():
            print(f"⚠️  Google Sheets database directory not found: {google_sheet_db_dir}")
            return None
        
        # Initialize database
        gs_db = GoogleSheetDatabase(data_dir=google_sheet_db_dir)
        
        # Get spreadsheet
        spreadsheet = gs_db.get_spreadsheet(spreadsheet_id)
        if not spreadsheet:
            print(f"⚠️  Spreadsheet not found in local database: {spreadsheet_id}")
            return None
        
        spreadsheet_title = spreadsheet.get('properties', {}).get('title', 'Unknown')
        print(f"📊 Reading from spreadsheet: {spreadsheet_title}")
        
        # Get sheets
        sheets = spreadsheet.get('sheets', [])
        if not sheets:
            print(f"⚠️  No sheets found in spreadsheet: {spreadsheet_id}")
            return None
        
        # Find sheet containing analysis results
        # Prioritize finding sheet with B2B analysis columns
        analysis_sheet = None
        for sheet in sheets:
            sheet_name = sheet['properties']['title']
            try:
                # Read first few rows to check column headers
                values = gs_db.get_values(spreadsheet_id, sheet_name, "A1:Z100")
                if values and len(values) > 1:
                    # Check if it contains NHL B2B analysis columns
                    headers = [str(h).strip().lower() for h in values[0]]
                    expected_columns = ['team', 'ha', 'ah', 'hh', 'aa', 'total']
                    
                    # Check if it contains expected columns
                    matched_columns = sum(1 for col in expected_columns if any(col in h for h in headers))
                    
                    if matched_columns >= 4:  # Match at least 4 expected columns
                        analysis_sheet = sheet_name
                        print(f"   ✓ Found analysis sheet: {sheet_name}")
                        break
            except Exception as e:
                print(f"   ⚠️  Could not read sheet {sheet_name}: {e}")
                continue
        
        # If no matching sheet found, use the first sheet
        if not analysis_sheet:
            analysis_sheet = sheets[0]['properties']['title']
            print(f"   ⚠️  Using first sheet as fallback: {analysis_sheet}")
        
        print(f"📊 Reading data from sheet: {analysis_sheet}")
        
        # Read data
        values = gs_db.get_values(spreadsheet_id, analysis_sheet, "A1:Z100")
        
        if not values or len(values) < 2:
            print(f"⚠️  Sheet contains no data or only headers")
            return None
        
        # Convert to DataFrame
        df = pd.DataFrame(values[1:], columns=values[0])
        print(f"   ✓ Loaded {len(df)} rows from local database")
        
        return df
        
    except Exception as e:
        print(f"⚠️  Error reading from local database: {e}")
        import traceback
        traceback.print_exc()
        return None

def find_spreadsheet_id_from_local_db(agent_workspace: str) -> Optional[str]:
    """
    Find nhl_b2b_analysis spreadsheet ID created by agent from local database
    Prioritize searching by title from spreadsheets.json in local db
    """
    workspace_path = Path(agent_workspace)
    
    # Method 1: Find nhl_b2b_analysis spreadsheet by title from local database
    workspace_parent = workspace_path.parent
    google_sheet_db_dir = workspace_parent / "local_db" / "google_sheets"
    spreadsheets_file = google_sheet_db_dir / "spreadsheets.json"
    
    if spreadsheets_file.exists():
        try:
            with open(spreadsheets_file, 'r') as f:
                spreadsheets_data = json.load(f)
            
            # Find spreadsheet with title nhl_b2b_analysis
            target_titles = ['nhl_b2b_analysis', 'NHL B2B Analysis', 'NHL-B2B-Analysis']
            
            for spreadsheet_id, spreadsheet_info in spreadsheets_data.items():
                title = spreadsheet_info.get('properties', {}).get('title', '')
                # Use flexible matching
                if any(target.lower() in title.lower() for target in target_titles):
                    print(f"🔍 Found spreadsheet from local database: '{title}' (ID: {spreadsheet_id})")
                    return spreadsheet_id
            
            print(f"⚠️ nhl_b2b_analysis spreadsheet not found in local database")
            print(f"   Available spreadsheets: {[(v.get('properties', {}).get('title', 'Unknown'), k) for k, v in spreadsheets_data.items()]}")
            
        except Exception as e:
            print(f"⚠️ Failed to read from spreadsheets.json: {e}")
    
    # Method 2: Try to read from sheet_id.txt (fallback - but this is usually the input data ID)
    sheet_id_file = workspace_path.parent.parent / "tasks" / "weihao" / "nhl-b2b-analysis-s2l" / "files" / "sheet_id.txt"
    if sheet_id_file.exists():
        try:
            with open(sheet_id_file, 'r') as f:
                spreadsheet_id = f.read().strip()
            if spreadsheet_id:
                print(f"🔍 Read spreadsheet ID from sheet_id.txt (fallback): {spreadsheet_id}")
                return spreadsheet_id
        except Exception as e:
            print(f"⚠️ Failed to read sheet_id.txt: {e}")
    
    # Method 3: Try to read from folder_id.txt (legacy method, for compatibility)
    folder_id_file = workspace_path.parent.parent / "tasks" / "finalpool" / "NHL-B2B-Analysis" / "files" / "folder_id.txt"
    if folder_id_file.exists():
        try:
            with open(folder_id_file, 'r') as f:
                folder_id = f.read().strip()
            print(f"🔍 Read folder ID from folder_id.txt: {folder_id}")
            return folder_id
        except Exception as e:
            print(f"⚠️ Failed to read folder_id.txt: {e}")
    
    return None

def try_csv_sheet_consistency_check(agent_workspace: str, groundtruth_workspace: str) -> Tuple[bool, str]:
    """
    Check consistency between Agent's CSV file and Google Sheet
    They should contain the same data!
    """
    try:
        # 1. Find Agent CSV output
        agent_csv_data = find_agent_csv_output_data(agent_workspace)
        if agent_csv_data is None:
            return False, "Agent CSV output not found"
        
        # 2. Find spreadsheet ID
        spreadsheet_id = find_spreadsheet_id_from_local_db(agent_workspace)
        if not spreadsheet_id:
            # Fallback to original method
            try:
                spreadsheet_id = find_spreadsheet_in_folder(agent_workspace)
            except:
                pass
        
        if not spreadsheet_id:
            return False, "Agent Google Sheet not found"
        
        # 3. Get Google Sheet data
        print("📊 Reading Google Sheet data for consistency check...")
        agent_sheet_data = fetch_google_sheet_data_from_local_db(agent_workspace, spreadsheet_id)
        
        # Fallback to Google API if local database fails
        if agent_sheet_data is None and GOOGLE_API_AVAILABLE:
            print("🌐 Trying Google API for Sheet data...")
            agent_sheet_data = fetch_google_sheet_data_gspread(spreadsheet_id)
        
        if agent_sheet_data is None:
            return False, "Cannot read Google Sheet data"
        
        # 4. Compare CSV and Sheet data
        comparison_passed, comparison_msg = compare_dataframes(
            agent_csv_data, 
            agent_sheet_data, 
            "CSV vs Sheet consistency"
        )
        
        if comparison_passed:
            return True, f"CSV and Google Sheet contain consistent data ({len(agent_csv_data)} rows)"
        else:
            return False, f"CSV and Google Sheet data mismatch: {comparison_msg}"
        
    except Exception as e:
        return False, f"Consistency check failed: {str(e)}"


def try_remote_sheet_comparison(agent_workspace: str, groundtruth_workspace: str) -> Tuple[bool, str]:
    """Try Google Sheet remote comparison - supports both local database and Google API"""
    try:
        # 1. Load standard answer CSV
        standard_csv_path = Path(groundtruth_workspace) / "standard_answer.csv"
        if not standard_csv_path.exists():
            return False, "Standard answer CSV file does not exist"

        standard_data = pd.read_csv(standard_csv_path)

        # 2. Find spreadsheet ID
        spreadsheet_id = find_spreadsheet_id_from_local_db(agent_workspace)
        if not spreadsheet_id:
            # Fallback to original method
            spreadsheet_id = find_spreadsheet_in_folder(agent_workspace)
        
        if not spreadsheet_id:
            return False, "Agent created Google Sheet not found"

        print(f"🔍 Found spreadsheet ID: {spreadsheet_id}")

        # 3. Try to get data from local database first
        print("📊 Trying to read from local database...")
        agent_data = fetch_google_sheet_data_from_local_db(agent_workspace, spreadsheet_id)
        
        # 4. If local database failed, try Google API
        if agent_data is None and GOOGLE_API_AVAILABLE:
            print("🌐 Local database read failed, trying Google API...")
            agent_data = fetch_google_sheet_data_gspread(spreadsheet_id)
        
        if agent_data is None:
            return False, f"Cannot get Agent sheet data from both local database and Google API: {spreadsheet_id}"

        # 5. Perform data comparison
        comparison_passed, comparison_msg = compare_dataframes(standard_data, agent_data, "Remote Sheet comparison")

        return comparison_passed, comparison_msg

    except Exception as e:
        return False, f"Remote Sheet comparison failed: {str(e)}"

def find_agent_csv_output_data(agent_workspace: str) -> Optional[pd.DataFrame]:
    """
    Find Agent output data from local CSV files
    """
    workspace_path = Path(agent_workspace)

    # Find CSV files - use keyword filtering
    csv_files = list(workspace_path.glob("*.csv"))
    for csv_file in csv_files:
        # Only check CSV files containing relevant keywords
        name = csv_file.name.lower()
        if any(keyword in name for keyword in ['nhl', 'back', 'b2b', 'back-to-back', 'analysis', 'sheet']):
            try:
                data = pd.read_csv(csv_file)
                if validate_nhl_data_structure(data):
                    return data
            except Exception:
                continue

    return None

def validate_nhl_data_structure(df: pd.DataFrame) -> bool:
    """
    Validate if data conforms to NHL back-to-back statistics structure
    """
    if df is None or df.empty:
        return False

    # Check required columns
    required_columns = ['Team', 'HA', 'AH', 'HH', 'AA', 'Total']

    # Allow column name variants
    column_variants = {
        'Team': ['Team', 'team', 'TEAM', 'Teams', 'TeamName'],
        'HA': ['HA', 'Home-Away', 'HomeAway'],
        'AH': ['AH', 'Away-Home', 'AwayHome'],
        'HH': ['HH', 'Home-Home', 'HomeHome'],
        'AA': ['AA', 'Away-Away', 'AwayAway'],
        'Total': ['Total', 'TOTAL', 'Sum']
    }

    matched_columns = {}
    for req_col in required_columns:
        for col in df.columns:
            if col in column_variants[req_col]:
                matched_columns[req_col] = col
                break

    # If not all required columns found, return False
    if len(matched_columns) < len(required_columns):
        return False

    # Rename columns to standard format
    df_renamed = df.rename(columns={v: k for k, v in matched_columns.items()})

    # Check if there is NHL team data (at least 2 teams for testing)
    if len(df_renamed) < 2:
        return False

    # Check if Team column contains NHL team names
    nhl_team_keywords = [
        'Maple Leafs', 'Bruins', 'Canadiens', 'Rangers', 'Blackhawks',
        'Lightning', 'Panthers', 'Avalanche', 'Kings', 'Sharks',
        'Wings', 'Flames', 'Oilers', 'Jets', 'Wild'
    ]

    team_names = ' '.join(df_renamed['Team'].astype(str).tolist()).lower()
    nhl_matches = sum(1 for keyword in nhl_team_keywords if keyword.lower() in team_names)

    if nhl_matches < 1:  # At least match 1 NHL team keyword
        return False

    return True

def compare_dataframes(standard_df: pd.DataFrame, agent_df: pd.DataFrame, comparison_type: str = "Data comparison") -> Tuple[bool, str]:
    """
    Compare two DataFrames - enhanced version, supports more flexible data validation
    """

    details = []
    issues = []
    warnings = []

    # 0. Data preprocessing and normalization
    try:
        standard_df = normalize_dataframe(standard_df.copy())
        agent_df = normalize_dataframe(agent_df.copy())
        
        # Extract only rows that match ground truth teams
        # This automatically filters out comments, notes, and extra rows
        agent_df = extract_matching_rows(agent_df, standard_df)
    except Exception as e:
        return False, f"❌ Data normalization failed: {str(e)}"

    # 1. Check column structure
    expected_columns = ['Team', 'HA', 'AH', 'HH', 'AA', 'Total']

    # Flexible column name matching
    column_mapping = find_column_mapping(agent_df.columns, expected_columns)

    if len(column_mapping) == len(expected_columns):
        details.append("✅ Header structure correct")
        # Rename columns for subsequent comparison
        agent_df = agent_df.rename(columns={v: k for k, v in column_mapping.items()})
    else:
        missing_cols = [col for col in expected_columns if col not in column_mapping]
        issues.append(f"❌ Missing required columns: {missing_cols}")
        details.append(f"   Expected: {expected_columns}")
        details.append(f"   Actual: {list(agent_df.columns)}")

    # 2. Check row count (strict mode: must be exactly the same)
    if len(standard_df) == len(agent_df):
        details.append(f"✅ Team count correct: {len(agent_df)} teams")
    else:
        issues.append(f"❌ Team count mismatch: expected {len(standard_df)}, actual {len(agent_df)} (strict mode requires exact match)")

    # 3. Mathematical consistency check (HA+AH+HH+AA=Total)
    math_validation_passed, math_details = validate_mathematical_consistency(agent_df)
    if math_validation_passed:
        details.append("✅ Mathematical consistency check passed")
    else:
        issues.append("❌ Mathematical consistency check failed")
        details.extend([f"   {detail}" for detail in math_details])

    # 4. Data complete consistency check
    if len(issues) == 0:  # Only perform data check when structure is correct

        try:
            # Normalize team names and sort
            standard_normalized = normalize_team_names(standard_df).sort_values('Team').reset_index(drop=True)
            agent_normalized = normalize_team_names(agent_df).sort_values('Team').reset_index(drop=True)

            # Compare row by row
            identical_rows = 0
            total_rows = min(len(standard_normalized), len(agent_normalized))
            mismatched_details = []

            for i in range(total_rows):
                std_row = standard_normalized.iloc[i]
                agent_row = agent_normalized.iloc[i]

                # Check if each field matches
                row_identical = True
                row_mismatches = []

                for col in expected_columns:
                    if col in std_row and col in agent_row:
                        # Strict mode: use both string and numeric comparison for dual verification
                        std_str = str(std_row[col]).strip()
                        agent_str = str(agent_row[col]).strip()

                        std_val = convert_to_number(std_row[col])
                        agent_val = convert_to_number(agent_row[col])

                        # Must satisfy both string and numeric equality
                        if std_val != agent_val or (col == 'Team' and std_str != agent_str):
                            row_identical = False
                            if col == 'Team':
                                row_mismatches.append(f"{col}: expected '{std_str}', actual '{agent_str}'")
                            else:
                                row_mismatches.append(f"{col}: expected {std_val}, actual {agent_val}")

                if row_identical:
                    identical_rows += 1
                else:
                    team_name = std_row['Team'] if 'Team' in std_row else f"Row {i+1}"
                    mismatched_details.append(f"    {team_name}: {', '.join(row_mismatches)}")

                    # Only show first 5 mismatched details
                    if len(mismatched_details) >= 5:
                        mismatched_details.append("    ...")
                        break

            # Calculate accuracy (strict mode: must be 100% consistent)
            accuracy = (identical_rows / total_rows * 100) if total_rows > 0 else 0

            if identical_rows == total_rows and total_rows == len(standard_df):
                details.append("✅ Data completely consistent!")
            else:
                # Strict mode: any inconsistency is failure
                issues.append(f"❌ Data not completely consistent: {accuracy:.1f}% ({identical_rows}/{total_rows}) - strict mode requires 100% consistency")
                if mismatched_details:
                    details.append("Mismatched rows:")
                    details.extend(mismatched_details)

        except Exception as e:
            issues.append(f"❌ Data comparison process error: {str(e)}")

    # 5. Generate final result (strict mode)
    result_parts = [f"🔍 {comparison_type} result (strict mode):"]

    if not issues:
        result_parts.append("🎉 Strict check completely passed!")
        result_parts.extend([f"  {detail}" for detail in details])
        return True, "\n".join(result_parts)
    else:
        result_parts.append("❌ Strict check failed")
        result_parts.append("\n❌ Failure reasons:")
        result_parts.extend([f"  {issue}" for issue in issues])

        if details:
            result_parts.append("\n✅ Passed checks:")
            result_parts.extend([f"  {detail}" for detail in details])

        result_parts.append("\n🎯 Strict mode requirements:")
        result_parts.append("  • Team count must be exactly the same")
        result_parts.append("  • Header structure must match completely")
        result_parts.append("  • Mathematical consistency must be 100% correct")
        result_parts.append("  • All data must be 100% consistent with standard answer")

        return False, "\n".join(result_parts)

def normalize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize DataFrame - basic cleanup only"""
    df = df.dropna(how='all')  # Remove completely empty rows
    df = df.loc[:, ~df.columns.str.contains('^Unnamed')]  # Remove unnamed columns

    # Remove spaces from column names
    df.columns = df.columns.str.strip()
    
    return df


def extract_matching_rows(agent_df: pd.DataFrame, standard_df: pd.DataFrame) -> pd.DataFrame:
    """
    Extract rows from agent_df that match teams in standard_df.
    
    This approach is more flexible than filtering by comment indicators:
    - Only extracts rows for teams that exist in ground truth
    - Automatically ignores any extra rows (comments, notes, metadata, etc.)
    - More robust to different output formats
    
    Args:
        agent_df: Agent's output DataFrame
        standard_df: Ground truth DataFrame
        
    Returns:
        DataFrame with only the rows matching ground truth teams
    """
    if len(agent_df) == 0 or len(standard_df) == 0:
        return agent_df
    
    # Find the team column (case-insensitive)
    team_col = None
    for col in agent_df.columns:
        if col.lower() in ['team', 'teams', 'teamname']:
            team_col = col
            break
    
    if team_col is None:
        # No team column found, return as-is
        return agent_df
    
    # Get team names from standard (normalize for comparison)
    standard_teams = set()
    for col in standard_df.columns:
        if col.lower() in ['team', 'teams', 'teamname']:
            standard_teams = set(normalize_team_names(standard_df[[col]]).iloc[:, 0].str.lower().str.strip())
            break
    
    if not standard_teams:
        return agent_df
    
    # Filter agent rows to only include teams from standard
    def matches_standard_team(team_name):
        """Check if team name matches any standard team"""
        if pd.isna(team_name):
            return False
        normalized = str(team_name).lower().strip()
        # Remove common variations
        normalized = normalized.replace('  ', ' ')
        return normalized in standard_teams
    
    matching_mask = agent_df[team_col].apply(matches_standard_team)
    matched_df = agent_df[matching_mask].reset_index(drop=True)
    
    return matched_df

def find_column_mapping(actual_columns: List[str], expected_columns: List[str]) -> Dict[str, str]:
    """Find column name mapping relationships"""
    column_variants = {
        'Team': ['Team', 'team', 'TEAM', 'Teams', 'TeamName'],
        'HA': ['HA', 'Home-Away', 'HomeAway'],
        'AH': ['AH', 'Away-Home', 'AwayHome'],
        'HH': ['HH', 'Home-Home', 'HomeHome'],
        'AA': ['AA', 'Away-Away', 'AwayAway'],
        'Total': ['Total', 'TOTAL', 'Sum']
    }

    mapping = {}
    for expected_col in expected_columns:
        for actual_col in actual_columns:
            if actual_col in column_variants[expected_col]:
                mapping[expected_col] = actual_col
                break

    return mapping

def validate_mathematical_consistency(df: pd.DataFrame) -> Tuple[bool, List[str]]:
    """Validate mathematical consistency: HA+AH+HH+AA=Total"""
    details = []

    if 'Total' not in df.columns:
        return False, ["Missing 'Total' column"]

    required_cols = ['HA', 'AH', 'HH', 'AA', 'Total']
    missing_cols = [col for col in required_cols if col not in df.columns]

    if missing_cols:
        return False, [f"Missing required columns: {missing_cols}"]

    inconsistent_rows = []

    for idx, row in df.iterrows():
        try:
            sum_parts = (convert_to_number(row['HA']) +
                        convert_to_number(row['AH']) +
                        convert_to_number(row['HH']) +
                        convert_to_number(row['AA']))
            total = convert_to_number(row['Total'])

            if sum_parts != total:
                team_name = row.get('Team', f'Row {idx+1}')
                inconsistent_rows.append(f"{team_name}: {sum_parts} ≠ {total}")

        except Exception as e:
            team_name = row.get('Team', f'Row {idx+1}')
            inconsistent_rows.append(f"{team_name}: data format error")

    if inconsistent_rows:
        details.append("Mathematical consistency errors:")
        details.extend(inconsistent_rows[:5])  # Only show first 5 errors
        if len(inconsistent_rows) > 5:
            details.append(f"... {len(inconsistent_rows)-5} more errors")
        return False, details

    details.append(f"All {len(df)} rows have correct mathematical consistency")
    return True, details

def normalize_team_names(df: pd.DataFrame) -> pd.DataFrame:
    """Strict mode: minimal normalization, requires exact matching"""
    if 'Team' not in df.columns:
        return df

    df = df.copy()
    # Only perform basic space cleaning, no name variant conversion
    df['Team'] = df['Team'].astype(str).str.strip()

    return df

def convert_to_number(value) -> float:
    """Convert value to number"""
    if pd.isna(value):
        return 0.0

    if isinstance(value, (int, float)):
        return float(value)

    # Try to convert string
    try:
        # Remove spaces and common non-numeric characters
        str_val = str(value).strip().replace(',', '').replace(' ', '')
        return float(str_val)
    except (ValueError, TypeError):
        return 0.0

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        workspace = sys.argv[1]
        groundtruth = sys.argv[2]
        passed, message = check_sheet_comparison(workspace, groundtruth)
        print(f"Check result: {'Passed' if passed else 'Failed'}")
        print(f"\n{message}")
    else:
        print("Usage: python check_sheet_comparison.py <agent_workspace> <groundtruth_workspace>")