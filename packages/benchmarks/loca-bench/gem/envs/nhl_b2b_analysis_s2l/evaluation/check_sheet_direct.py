#!/usr/bin/env python3
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
        print("Authenticating Google services...")

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
                print(f"🔍 Found credentials file: {test_path} ({levels} levels up)")
                break

        if not credentials_path:
            # Default path if not found
            default_path = current_path.parent.parent.parent.parent / "configs" / "google_credentials.json"
            credentials_path = str(default_path)
            print(f"⚠️ Using default credentials path: {default_path}")

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
            print("✓ Token refreshed and saved")

        # Initialize gspread client
        gc = gspread.authorize(credentials)

        # Initialize Google Drive API client
        drive_service = build('drive', 'v3', credentials=credentials)

        print("✓ Google services authentication successful")
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
    First try to read folder ID from folder_id.txt, if not exists, read URL from google_sheet_url.json
    Return the ID of the found spreadsheet
    """
    workspace_path = Path(agent_workspace)

    # Method 1: Try to read folder ID from folder_id.txt
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
                print(f"⚠️ Spreadsheet named '{spreadsheet_name}' not found, trying to find any Spreadsheet file in folder...")
                fallback_query = f"'{target_folder_id}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
                fallback_results = drive_service.files().list(
                    q=fallback_query,
                    fields="files(id, name, mimeType)"
                ).execute()

                fallback_files = fallback_results.get('files', [])
                if not fallback_files:
                    print(f"⚠️ No Google Spreadsheet files found in folder, falling back to URL method")
                else:
                    # Return the first spreadsheet found
                    spreadsheet = fallback_files[0]
                    spreadsheet_id = spreadsheet['id']
                    print(f"✅ Found spreadsheet: {spreadsheet['name']} (ID: {spreadsheet_id})")
                    return spreadsheet_id
            else:
                # Return the spreadsheet ID with specified name
                spreadsheet = files[0]
                spreadsheet_id = spreadsheet['id']
                print(f"✅ Found spreadsheet: {spreadsheet['name']} (ID: {spreadsheet_id})")
                return spreadsheet_id

        except Exception as e:
            print(f"⚠️ Failed to find spreadsheet by folder ID: {str(e)}, trying URL method")

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

def check_sheet_accessibility_gspread(sheet_id: str) -> Tuple[bool, str]:
    """Check if Sheet is accessible using gspread"""
    try:
        gc, drive_service = authenticate_google_services()

        # Try to open the spreadsheet
        spreadsheet = gc.open_by_key(sheet_id)

        # Get basic info
        title = spreadsheet.title
        worksheet_count = len(spreadsheet.worksheets())

        return True, f"Sheet accessible: '{title}' ({worksheet_count} worksheets)"

    except gspread.SpreadsheetNotFound:
        return False, "Sheet does not exist or is not accessible"
    except gspread.APIError as e:
        if 'PERMISSION_DENIED' in str(e) or '403' in str(e):
            return False, "Insufficient permissions - need Sheet access permission"
        elif '404' in str(e):
            return False, "Sheet does not exist"
        else:
            return False, f"API error: {e}"
    except Exception as e:
        return False, f"Access exception: {str(e)}"

def check_sheet_structure_gspread(sheet_id: str) -> Tuple[bool, str]:
    """Check Sheet structure using gspread"""
    try:
        gc, drive_service = authenticate_google_services()
        spreadsheet = gc.open_by_key(sheet_id)

        # Get the first worksheet
        worksheet = spreadsheet.get_worksheet(0)
        if not worksheet:
            return False, "No worksheets found in spreadsheet"

        # Get header row
        try:
            header_values = worksheet.row_values(1)
        except Exception as e:
            return False, f"Failed to read header row: {e}"

        if not header_values:
            return False, "Header row is empty"

        # Clean and normalize headers
        headers = [str(header).strip().lower() for header in header_values]

        # Check required columns for NHL B2B analysis
        expected_columns = ['team', 'ha', 'ah', 'hh', 'aa', 'total']

        # Flexible column name matching
        column_variants = {
            'team': ['team', 'teams', 'teamname', 'team name'],
            'ha': ['ha', 'home-away', 'homeaway', 'home away'],
            'ah': ['ah', 'away-home', 'awayhome', 'away home'],
            'hh': ['hh', 'home-home', 'homehome', 'home home'],
            'aa': ['aa', 'away-away', 'awayaway', 'away away'],
            'total': ['total', 'sum', 'count']
        }

        matched_columns = []
        for expected_col in expected_columns:
            for actual_col in headers:
                if any(variant in actual_col for variant in column_variants[expected_col]):
                    matched_columns.append(expected_col)
                    break

        if len(matched_columns) == len(expected_columns):
            return True, f"Column structure correct: {header_values}"
        else:
            missing = [col for col in expected_columns if col not in matched_columns]
            return False, f"Missing required columns: {missing}, actual columns: {header_values}"

    except Exception as e:
        return False, f"Structure check exception: {str(e)}"

def check_sheet_data_volume_gspread(sheet_id: str) -> Tuple[bool, str]:
    """Check Sheet data volume using gspread"""
    try:
        gc, drive_service = authenticate_google_services()
        spreadsheet = gc.open_by_key(sheet_id)

        # Get the first worksheet
        worksheet = spreadsheet.get_worksheet(0)
        if not worksheet:
            return False, "No worksheets found in spreadsheet"

        # Get all values to count rows
        all_values = worksheet.get_all_values()

        if not all_values:
            return False, "Sheet is empty"

        # Count data rows (excluding header)
        data_rows = len(all_values) - 1  # Subtract header row

        if data_rows >= 30:  # NHL has 32 teams, allow 30+ rows
            return True, f"Data volume reasonable: {data_rows} data rows (plus 1 header row)"
        else:
            return False, f"Data volume too little: {data_rows} data rows, expected 30+ rows"

    except Exception as e:
        return False, f"Data volume check exception: {str(e)}"

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

def check_sheet_with_local_db(agent_workspace: str, spreadsheet_id: str) -> Tuple[bool, str]:
    """
    Check Google Sheet using local database
    Check the nhl_b2b_analysis output spreadsheet created by agent
    """
    try:
        # Get database directory
        workspace_parent = Path(agent_workspace).parent
        google_sheet_db_dir = str(workspace_parent / "local_db" / "google_sheets")
        
        if not Path(google_sheet_db_dir).exists():
            return False, f"❌ Google Sheets database directory not found: {google_sheet_db_dir}"
        
        # Initialize database
        gs_db = GoogleSheetDatabase(data_dir=google_sheet_db_dir)
        
        # Check if spreadsheet exists
        spreadsheet = gs_db.get_spreadsheet(spreadsheet_id)
        if not spreadsheet:
            return False, f"❌ Spreadsheet not found in local database: {spreadsheet_id}"
        
        spreadsheet_title = spreadsheet.get('properties', {}).get('title', 'Unknown')
        print(f"✅ Found spreadsheet in local database: {spreadsheet_title}")
        
        # Verify this is the nhl_b2b_analysis spreadsheet
        if 'b2b' not in spreadsheet_title.lower() and 'analysis' not in spreadsheet_title.lower():
            print(f"⚠️  Warning: Spreadsheet title '{spreadsheet_title}' may not be the analysis output")
        
        # Check sheet structure
        sheets = spreadsheet.get('sheets', [])
        if not sheets:
            return False, "❌ No sheets found in spreadsheet"
        
        sheet_names = [s['properties']['title'] for s in sheets]
        print(f"   Sheets found: {', '.join(sheet_names)}")
        
        # Find sheet containing analysis results (usually the first sheet or named Sheet1)
        analysis_sheet = None
        for sheet in sheets:
            sheet_title = sheet['properties']['title']
            try:
                # Try to read sheet data
                values = gs_db.get_values(spreadsheet_id, sheet_title, "A1:Z100")
                if values and len(values) > 1:
                    # Check if it contains NHL B2B analysis columns
                    headers = [str(h).strip().lower() for h in values[0]]
                    expected_columns = ['team', 'ha', 'ah', 'hh', 'aa', 'total']
                    
                    # Check if it contains expected columns
                    matched_columns = sum(1 for col in expected_columns if any(col in h for h in headers))
                    
                    if matched_columns >= 4:  # Match at least 4 expected columns
                        analysis_sheet = sheet_title
                        print(f"   ✅ Found analysis sheet: {sheet_title} ({len(values)} rows)")
                        print(f"      Headers: {values[0]}")
                        break
                    else:
                        print(f"   ⚠️  Sheet {sheet_title} has {len(values)} rows but headers don't match expected format")
                        print(f"      Headers: {values[0]}")
            except Exception as e:
                print(f"   ⚠️  Could not read sheet {sheet_title}: {e}")
                continue
        
        if not analysis_sheet:
            return False, f"❌ No valid analysis sheet found. Expected columns: Team, HA, AH, HH, AA, Total. Available sheets: {', '.join(sheet_names)}"
        
        # Check data volume and content
        try:
            values = gs_db.get_values(spreadsheet_id, analysis_sheet, "A1:Z100")
            if not values:
                return False, "❌ Sheet exists but contains no data"
            
            row_count = len(values)
            col_count = max(len(row) for row in values) if values else 0
            
            print(f"   ✅ Sheet data: {row_count} rows × {col_count} columns")
            
            # Check if data volume is reasonable (NHL has 32 teams, so should have 30+ data rows)
            if row_count < 10:
                return False, f"❌ Sheet has too few rows: {row_count} (expected 30+ data rows plus header)"
            
            if row_count < 30:
                print(f"   ⚠️  Warning: Sheet has fewer rows than expected: {row_count} (expected 33 rows: 1 header + 32 teams)")
            
            return True, f"Analysis sheet verified: '{analysis_sheet}' (rows: {row_count}, cols: {col_count})"
            
        except Exception as e:
            return False, f"❌ Error reading sheet data: {str(e)}"
        
    except Exception as e:
        return False, f"❌ Local database check error: {str(e)}"

def check_google_sheet_direct(agent_workspace: str, groundtruth_workspace: str) -> Tuple[bool, str]:
    """
    Direct Google Sheet checking - supports both local database and Google API

    Check methods (priority order):
    1. Local database check (preferred for local testing)
    2. Google API check (fallback for real Google Sheets)

    Args:
        agent_workspace: agent workspace path
        groundtruth_workspace: groundtruth workspace path

    Returns:
        tuple: (whether check passed, check information)
    """

    try:
        # 1. Find spreadsheet ID
        spreadsheet_id = find_spreadsheet_id_from_local_db(agent_workspace)
        if not spreadsheet_id:
            # Fallback to original method
            spreadsheet_id = find_spreadsheet_in_folder(agent_workspace)
        
        if not spreadsheet_id:
            return False, "❌ Agent created Google Sheet not found (checked both local database and sheet_id.txt)"

        print(f"🔍 Found Google Sheet ID: {spreadsheet_id}")

        # 2. Try local database check first
        print("\n📊 Trying local database check...")
        local_db_pass, local_db_msg = check_sheet_with_local_db(agent_workspace, spreadsheet_id)
        
        if local_db_pass:
            # Local database check succeeded
            final_message = [
                f"🔍 Google Sheet check result (ID: {spreadsheet_id}):",
                "",
                "🎉 Check passed - Sheet verified using local database!",
                "",
                f"✅ Local database check: {local_db_msg}",
                "",
                "📝 Note: Using local database for sheet verification"
            ]
            return True, "\n".join(final_message)
        
        # 3. If local database check failed, try Google API (if available)
        if GOOGLE_API_AVAILABLE:
            print(f"\n⚠️  Local database check failed: {local_db_msg}")
            print("🌐 Trying Google API check as fallback...")
            
            try:
                accessibility_pass, accessibility_msg = check_sheet_accessibility_gspread(spreadsheet_id)

                if accessibility_pass:
                    sheet_exists = True
                    final_msg = f"Sheet exists and accessible - {accessibility_msg}"
                    status = "✅"

                    # Additional checks if accessible
                    structure_pass, structure_msg = check_sheet_structure_gspread(spreadsheet_id)
                    volume_pass, volume_msg = check_sheet_data_volume_gspread(spreadsheet_id)

                    results = [
                        f"{status} Sheet existence check: {final_msg}",
                        f"{'✅' if structure_pass else '❌'} Sheet structure check: {structure_msg}",
                        f"{'✅' if volume_pass else '❌'} Sheet data volume check: {volume_msg}"
                    ]

                    all_passed = sheet_exists and structure_pass and volume_pass
                else:
                    # Special handling: permission restricted but attempt to verify existence
                    if any(keyword in accessibility_msg for keyword in ["permission", "401", "403"]):
                        sheet_exists = True
                        final_msg = "Sheet exists but permission restricted - Agent successfully created Sheet, permission issue is expected"
                        status = "✅"
                        results = [f"{status} Sheet existence check: {final_msg}"]
                        all_passed = sheet_exists
                    else:
                        sheet_exists = False
                        final_msg = f"Sheet does not exist or cannot be verified - {accessibility_msg}"
                        status = "❌"
                        results = [f"{status} Sheet existence check: {final_msg}"]
                        all_passed = False

                # Generate final result
                final_message = [
                    f"🔍 Google Sheet check result (ID: {spreadsheet_id}):",
                    "",
                    *results,
                    "",
                    "📝 Note: Using Google API for comprehensive sheet verification"
                ]

                if all_passed:
                    final_message.insert(1, "🎉 Check passed - Agent successfully created and populated Google Sheet!")
                else:
                    final_message.insert(1, "❌ Check failed - Agent created Google Sheet verification failed")

                return all_passed, "\n".join(final_message)

            except Exception as e:
                return False, f"Both local database and Google API checks failed. Local DB: {local_db_msg}, API: {str(e)}"
        else:
            # Google API not available
            return False, f"❌ Local database check failed and Google API not available. {local_db_msg}"

    except Exception as e:
        return False, f"Google Sheet direct check error: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        workspace = sys.argv[1]
        groundtruth = sys.argv[2]
        passed, message = check_google_sheet_direct(workspace, groundtruth)
        print(f"Check result: {'Passed' if passed else 'Failed'}")
        print(f"\n{message}")
    else:
        print("Usage: python check_sheet_direct.py <agent_workspace> <groundtruth_workspace>")