#!/usr/bin/env python3
"""
Google Sheets Client - For setting up BOM and inventory data
"""

import json
import logging
import os
from typing import Dict, List, Optional
from googleapiclient.errors import HttpError
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
import sys
import os
import asyncio
from argparse import ArgumentParser

sys.path.append(os.path.dirname(__file__))

from utils.app_specific.googlesheet.drive_helper import (
    get_google_service, find_folder_by_name, create_folder, 
    clear_folder, copy_sheet_to_folder
)

import sys
import os
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(current_dir))
sys.path.append(project_root)

try:
    import gspread
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    
    # Try to import configuration
    try:
        from token_key_session import all_token_key_session
        TARGET_FOLDER_ID = all_token_key_session.get('google_sheets_folder_id', "13K_oZ32wICyZUai_ETcwicAP2K2P0_pZ")
    except ImportError:
        TARGET_FOLDER_ID = "13K_oZ32wICyZUai_ETcwicAP2K2P0_pZ"  # Fallback hardcoded value
        
except ImportError as e:
    print(f"Warning: Google API dependencies not available: {e}")
    gspread = None
    service_account = None
    TARGET_FOLDER_ID = "13K_oZ32wICyZUai_ETcwicAP2K2P0_pZ"

# Google Sheets API scopes
SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
]
SA_KEY_FILE_PATH = 'configs/credentials.json'
TARGET_SPREADSHEET_NAME = "Material_Inventory"

class GoogleSheetsClient:
    """Google Sheets Client"""

    def __init__(self, credentials_file: str = SA_KEY_FILE_PATH):
        """
        Initialize Google Sheets client

        Args:
            credentials_file: Service account credentials file path
        """
        self.credentials_file = credentials_file
        self.service = None
        self.drive_service = None  # Drive API service
        self.gc = None  # gspread client
        self.logger = self._setup_logging()

    def _setup_logging(self):
        """Setup logging"""
        logging.basicConfig(level=logging.INFO)
        return logging.getLogger(__name__)

    def authenticate(self) -> bool:
        """
        Authenticate Google Sheets API - using service account credentials

        Returns:
            Whether authentication was successful
        """
        try:
            self.logger.info("Authenticating Google services using service account...")
            with open(self.credentials_file, 'r') as f:
                creds_data = json.load(f)
        
        # Create OAuth2 credentials object
            credentials = Credentials(
                token=creds_data.get('token'),
                refresh_token=creds_data.get('refresh_token'),
                token_uri=creds_data.get('token_uri'),
                client_id=creds_data.get('client_id'),
                client_secret=creds_data.get('client_secret'),
                scopes=creds_data.get('scopes', SCOPES)
            )
            # Create credentials using service account credential file
            # credentials = service_account.Credentials.from_service_account_file(
            #     self.credentials_file, scopes=SCOPES)

            # Build Google Sheets API service
            self.service = build('sheets', 'v4', credentials=credentials)

            # Build Google Drive API service
            self.drive_service = build('drive', 'v3', credentials=credentials)

            # Also initialize gspread client
            self.gc = gspread.authorize(credentials)
            self.logger.info("Google Sheets API authentication successful")
            return True

        except FileNotFoundError:
            self.logger.error(f"Error: Service account credentials file not found '{self.credentials_file}'")
            return False
        except json.JSONDecodeError:
            self.logger.error(f"Error: Service account credentials file format error '{self.credentials_file}'")
            return False
        except Exception as e:
            self.logger.error(f"Google service authentication failed: {e}")
            return False

    def check_folder_access(self, folder_id: str) -> bool:
        """
        Check if the specified folder is accessible

        Args:
            folder_id: Folder ID

        Returns:
            Whether access is possible
        """
        if not self.drive_service:
            self.logger.error("Drive service not initialized")
            return False

        try:
            folder = self.drive_service.files().get(fileId=folder_id, fields='id,name,mimeType').execute()
            if folder.get('mimeType') == 'application/vnd.google-apps.folder':
                self.logger.info(f"Folder access successful: {folder.get('name')} ({folder_id})")
                return True
            else:
                self.logger.error(f"Specified ID is not a folder: {folder.get('mimeType')}")
                return False

        except HttpError as error:
            self.logger.error(f"Cannot access folder {folder_id}: {error}")
            return False
        except Exception as e:
            self.logger.error(f"Error checking folder access permissions: {e}")
            return False

    def move_to_folder(self, file_id: str, folder_id: str) -> bool:
        """
        Move file to specified folder

        Args:
            file_id: File ID
            folder_id: Target folder ID

        Returns:
            Whether move was successful
        """
        if not self.drive_service:
            self.logger.error("Drive service not initialized")
            return False

        try:
            self.logger.info(f"Starting to move file {file_id} to folder {folder_id}")

            # Get current file's parent folder
            file = self.drive_service.files().get(fileId=file_id, fields='parents').execute()
            previous_parents = ",".join(file.get('parents', []))
            self.logger.info(f"Current parent folder: {previous_parents}")

            # Move file to new folder
            file = self.drive_service.files().update(
                fileId=file_id,
                addParents=folder_id,
                removeParents=previous_parents,
                fields='id, parents'
            ).execute()

            new_parents = ",".join(file.get('parents', []))
            self.logger.info(f"File {file_id} successfully moved to folder {folder_id}, new parent folder: {new_parents}")
            return True

        except HttpError as error:
            self.logger.error(f"Failed to move file: {error}")
            self.logger.error(f"Error details: {error.resp.status} - {error.content}")
            return False
        except Exception as e:
            self.logger.error(f"Unexpected error while moving file: {e}")
            return False

    def create_test_spreadsheet(self, title: str = "Material Inventory Management Test") -> Optional[str]:
        """
        Create test spreadsheet

        Args:
            title: Spreadsheet title

        Returns:
            Spreadsheet ID, None if failed
        """
        if not self.service:
            self.logger.error("Service not initialized")
            return None
        
        try:
            spreadsheet = {
                'properties': {
                    'title': title
                },
                'sheets': [
                    {
                        'properties': {
                            'title': 'BOM',
                            'gridProperties': {
                                'rowCount': 1000,
                                'columnCount': 26
                            }
                        }
                    },
                    {
                        'properties': {
                            'title': 'Material_Inventory',
                            'gridProperties': {
                                'rowCount': 1000,
                                'columnCount': 26
                            }
                        }
                    }
                ]
            }
            
            result = self.service.spreadsheets().create(body=spreadsheet).execute()
            spreadsheet_id = result.get('spreadsheetId')

            # Move newly created spreadsheet to specified folder
            if spreadsheet_id and TARGET_FOLDER_ID:
                self.logger.info(f"Attempting to move spreadsheet {spreadsheet_id} to folder {TARGET_FOLDER_ID}")

                # First check if folder is accessible
                if not self.check_folder_access(TARGET_FOLDER_ID):
                    self.logger.error(f"Cannot access target folder {TARGET_FOLDER_ID}, skipping move operation")
                elif self.move_to_folder(spreadsheet_id, TARGET_FOLDER_ID):
                    self.logger.info(f"Spreadsheet successfully moved to specified folder: {TARGET_FOLDER_ID}")
                else:
                    self.logger.warning("Spreadsheet created successfully but failed to move to specified folder")
            elif not TARGET_FOLDER_ID:
                self.logger.warning("TARGET_FOLDER_ID not set, skipping spreadsheet move")
            else:
                self.logger.warning("spreadsheet_id is empty, cannot move spreadsheet")

            self.logger.info(f"Spreadsheet created successfully: {spreadsheet_id}")
            return spreadsheet_id

        except HttpError as error:
            self.logger.error(f"Failed to create spreadsheet: {error}")
            return None

    def setup_bom_data(self, spreadsheet_id: str) -> bool:
        """
        Setup BOM data

        Args:
            spreadsheet_id: Spreadsheet ID

        Returns:
            Whether setup was successful
        """
        if not self.service:
            self.logger.error("Service not initialized")
            return False
        
        # BOM data
        bom_data = [
            ['Product SKU', 'Product Name', 'Material ID', 'Material Name', 'Unit Usage', 'Unit'],
            ['CHAIR_001', 'Classic Wooden Chair', 'WOOD_OAK', 'Oak Wood Board', '2.5', 'sqm'],
            ['CHAIR_001', 'Classic Wooden Chair', 'SCREW_M6', 'M6 Screw', '8', 'pcs'],
            ['CHAIR_001', 'Classic Wooden Chair', 'GLUE_WOOD', 'Wood Glue', '0.1', 'L'],
            ['CHAIR_001', 'Classic Wooden Chair', 'FINISH_VARNISH', 'Varnish', '0.2', 'L'],
            ['TABLE_001', 'Oak Dining Table', 'WOOD_OAK', 'Oak Wood Board', '5.0', 'sqm'],
            ['TABLE_001', 'Oak Dining Table', 'SCREW_M8', 'M8 Screw', '12', 'pcs'],
            ['TABLE_001', 'Oak Dining Table', 'GLUE_WOOD', 'Wood Glue', '0.3', 'L'],
            ['TABLE_001', 'Oak Dining Table', 'FINISH_VARNISH', 'Varnish', '0.5', 'L'],
            ['DESK_001', 'Office Desk', 'WOOD_PINE', 'Pine Wood Board', '3.0', 'sqm'],
            ['DESK_001', 'Office Desk', 'METAL_LEG', 'Metal Table Leg', '4', 'pcs'],
            ['DESK_001', 'Office Desk', 'SCREW_M6', 'M6 Screw', '16', 'pcs'],
            ['DESK_001', 'Office Desk', 'FINISH_PAINT', 'Paint', '0.3', 'L']
        ]
        
        try:
            body = {
                'values': bom_data
            }
            
            result = self.service.spreadsheets().values().update(
                spreadsheetId=spreadsheet_id,
                range='BOM!A1',
                valueInputOption='RAW',
                body=body
            ).execute()

            self.logger.info(f"BOM data setup successful, updated {result.get('updatedCells')} cells")
            return True

        except HttpError as error:
            self.logger.error(f"Failed to setup BOM data: {error}")
            return False

    def setup_inventory_data(self, spreadsheet_id: str) -> bool:
        """
        Setup inventory data

        Args:
            spreadsheet_id: Spreadsheet ID

        Returns:
            Whether setup was successful
        """
        if not self.service:
            self.logger.error("Service not initialized")
            return False
        
        inventory_data = [
            ['Material ID', 'Material Name', 'Current Stock', 'Unit', 'Min Stock', 'Supplier'],
            ['WOOD_OAK', 'Oak Wood Board', '250.0', 'sqm', '10.0', 'Wood Supplier A'],
            ['SCREW_M6', 'M6 Screw', '600', 'pcs', '200', 'Hardware Supplier A'],
            ['SCREW_M8', 'M8 Screw', '450', 'pcs', '150', 'Hardware Supplier A'],
            ['GLUE_WOOD', 'Wood Glue', '15.0', 'L', '1.0', 'Chemical Supplier'],
            ['FINISH_VARNISH', 'Varnish', '25.0', 'L', '0.5', 'Paint Supplier'],
            ['WOOD_PINE', 'Pine Wood Board', '100.0', 'sqm', '8.0', 'Wood Supplier B'],
            ['METAL_LEG', 'Metal Table Leg', '100', 'pcs', '5', 'Metal Factory'],
            ['FINISH_PAINT', 'Paint', '10.0', 'L', '0.5', 'Paint Supplier']
        ]
        
        try:
            body = {
                'values': inventory_data
            }
            
            result = self.service.spreadsheets().values().update(
                spreadsheetId=spreadsheet_id,
                range='Material_Inventory!A1',
                valueInputOption='RAW',
                body=body
            ).execute()

            self.logger.info(f"Inventory data setup successful, updated {result.get('updatedCells')} cells")
            return True

        except HttpError as error:
            self.logger.error(f"Failed to setup inventory data: {error}")
            return False

    def find_spreadsheets_in_folder(self, folder_id: str) -> List[Dict[str, str]]:
        """
        Find all Google Sheets in the specified folder

        Args:
            folder_id: Folder ID

        Returns:
            List containing spreadsheet info, each element contains 'id' and 'name'
        """
        if not self.drive_service:
            self.logger.error("Drive service not initialized")
            return []

        try:
            # Find all Google Sheets in folder
            query = f"'{folder_id}' in parents and mimeType='application/vnd.google-apps.spreadsheet'"
            results = self.drive_service.files().list(
                q=query,
                fields="files(id, name)"
            ).execute()

            files = results.get('files', [])
            self.logger.info(f"Found {len(files)} spreadsheets in folder {folder_id}")

            for file in files:
                self.logger.info(f"  - {file['name']} ({file['id']})")

            return files

        except HttpError as error:
            self.logger.error(f"Failed to find spreadsheets in folder: {error}")
            return []
        except Exception as e:
            self.logger.error(f"Error finding spreadsheets: {e}")
            return []

    def find_spreadsheet_by_name_pattern(self, folder_id: str, name_pattern: str = None) -> Optional[str]:
        """
        Find specific spreadsheet by name pattern in folder

        Args:
            folder_id: Folder ID
            name_pattern: Name pattern, defaults to finding spreadsheets containing 'Material_Inventory' or 'inventory'

        Returns:
            Found spreadsheet ID, None if not found
        """
        spreadsheets = self.find_spreadsheets_in_folder(folder_id)

        if not spreadsheets:
            return None

        # If only one spreadsheet, return it directly
        if len(spreadsheets) == 1:
            self.logger.info(f"Only one spreadsheet in folder, using: {spreadsheets[0]['name']}")
            return spreadsheets[0]['id']

        # Find by name pattern
        if name_pattern is None:
            # Default to finding spreadsheets containing inventory-related keywords
            patterns = ['Material_Inventory', 'material_inventory', 'inventory', 'Inventory']
        else:
            patterns = [name_pattern]

        for pattern in patterns:
            for sheet in spreadsheets:
                if pattern.lower() in sheet['name'].lower():
                    self.logger.info(f"Found matching spreadsheet: {sheet['name']} (pattern: {pattern})")
                    return sheet['id']

        # If no match found, return the first one
        self.logger.warning(f"No spreadsheet matching pattern found, using first one: {spreadsheets[0]['name']}")
        return spreadsheets[0]['id']

    def get_current_inventory(self, folder_or_spreadsheet_id: str) -> Dict[str, float]:
        """
        Get current inventory data

        Args:
            folder_or_spreadsheet_id: Folder ID or spreadsheet ID

        Returns:
            Inventory data dictionary
        """
        if not self.service:
            self.logger.error("Service not initialized")
            return {}

        spreadsheet_id = folder_or_spreadsheet_id

        # First try to detect if this is a folder ID
        try:
            # Check if it's a folder
            if self.drive_service:
                file_info = self.drive_service.files().get(
                    fileId=folder_or_spreadsheet_id,
                    fields='mimeType,name'
                ).execute()

                if file_info.get('mimeType') == 'application/vnd.google-apps.folder':
                    self.logger.info(f"Detected folder ID: {folder_or_spreadsheet_id}")
                    # Find spreadsheet in folder
                    spreadsheet_id = self.find_spreadsheet_by_name_pattern(folder_or_spreadsheet_id)
                    if not spreadsheet_id:
                        self.logger.error("No spreadsheet found in folder")
                        return {}
                    self.logger.info(f"Using spreadsheet ID: {spreadsheet_id}")
                else:
                    self.logger.info(f"Using direct spreadsheet ID: {folder_or_spreadsheet_id}")
        except Exception as e:
            # If unable to detect type, assume it's a spreadsheet ID
            self.logger.warning(f"Unable to detect file type, assuming spreadsheet ID: {e}")
        
        try:
            result = self.service.spreadsheets().values().get(
                spreadsheetId=spreadsheet_id,
                range='Material_Inventory!A2:C100'
            ).execute()
            
            values = result.get('values', [])
            inventory = {}
            
            for row in values:
                if len(row) >= 3:
                    material_id = row[0]
                    try:
                        current_stock = float(row[2])
                        inventory[material_id] = current_stock
                    except (ValueError, TypeError):
                        continue
            
            return inventory
            
        except HttpError as error:
            self.logger.error(f"Failed to get inventory data: {error}")
            return {}

import os

if __name__ == "__main__":
    # Test Google Sheets client
    client = GoogleSheetsClient()

    # Authenticate
    if not client.authenticate():
        print("Google Sheets authentication failed")
        exit(1)

    # Create test spreadsheet
    spreadsheet_id = client.create_test_spreadsheet()
    if not spreadsheet_id:
        print("Failed to create spreadsheet")
        exit(1)

    print(f"Spreadsheet created successfully: {spreadsheet_id}")

    # Setup data
    if client.setup_bom_data(spreadsheet_id):
        print("BOM data setup successful")
    else:
        print("BOM data setup failed")

    if client.setup_inventory_data(spreadsheet_id):
        print("Inventory data setup successful")
    else:
        print("Inventory data setup failed")

    # Save spreadsheet ID
    config = {'spreadsheet_id': spreadsheet_id}
    with open('test_config.json', 'w') as f:
        json.dump(config, f, indent=2)

    print(f"Configuration saved to test_config.json")
    print(f"Spreadsheet link: https://docs.google.com/spreadsheets/d/{spreadsheet_id}")


    GOOGLESHEET_URLS = [
    "https://docs.google.com/spreadsheets/d/1S9BFFHU262CjU87DnGFfP_LMChhAT4lx7uNvwY-7HoI",
    ]

    FOLDER_NAME = "update-material-inventory"

    drive_service, sheets_service = get_google_service()

    folder_id = find_folder_by_name(drive_service, FOLDER_NAME)
    if not folder_id:
        folder_id = create_folder(drive_service, FOLDER_NAME)
    clear_folder(drive_service, folder_id)

    for sheet_url in GOOGLESHEET_URLS:
        copy_sheet_to_folder(drive_service, sheet_url, folder_id)    
