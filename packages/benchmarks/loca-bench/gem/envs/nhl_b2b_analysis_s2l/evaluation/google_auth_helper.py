import os
import json
import requests
import pandas as pd
from pathlib import Path
from typing import Optional, Tuple
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

class GoogleSheetsAuthenticator:
    """Google Sheets authentication and access class"""
    
    def __init__(self, credentials_path: str = None):
        """
        Initialize authenticator
        
        Args:
            credentials_path: credentials file path, defaults to project configuration
        """
        self.credentials_path = credentials_path or self._get_default_credentials_path()
        self.credentials = None
        self.service = None
        
    def _get_default_credentials_path(self) -> str:
        """Get default credentials file path"""
        # Smart path detection - try multiple possible paths
        current_path = Path(__file__).parent
        
        # Try different levels of upward search
        for levels in range(1, 7):  # Maximum 6 levels up
            test_root = current_path
            for _ in range(levels):
                test_root = test_root.parent
            
            test_path = test_root / "configs" / "google_credentials.json"
            if test_path.exists():
                print(f"🔍 Found credentials file: {test_path} ({levels} levels up)")
                return str(test_path)
        
        
        # Return default calculated path (even if it doesn't exist)
        default_path = current_path.parent.parent.parent.parent / "configs" / "google_credentials.json"
        print(f"⚠️ Credentials file not found, using default path: {default_path}")
        return str(default_path)
    
    def authenticate(self) -> bool:
        """
        Execute authentication
        
        Returns:
            bool: whether authentication was successful
        """
        try:
            # Load authentication information
            with open(self.credentials_path, 'r') as f:
                creds_data = json.load(f)
            
            # Create Credentials object
            self.credentials = Credentials(
                token=creds_data.get('token'),
                refresh_token=creds_data.get('refresh_token'),
                token_uri=creds_data.get('token_uri'),
                client_id=creds_data.get('client_id'),
                client_secret=creds_data.get('client_secret'),
                scopes=creds_data.get('scopes', [])
            )
            
            # Refresh token if needed
            if self.credentials.expired:
                self.credentials.refresh(Request())
                # Save updated token
                self._save_updated_credentials()
            
            # Create Sheets API service
            self.service = build('sheets', 'v4', credentials=self.credentials)
            return True
            
        except Exception as e:
            print(f"❌ Google authentication failed: {e}")
            return False
    
    def _save_updated_credentials(self):
        """Save updated authentication information"""
        try:
            with open(self.credentials_path, 'r') as f:
                creds_data = json.load(f)
            
            creds_data['token'] = self.credentials.token
            
            with open(self.credentials_path, 'w') as f:
                json.dump(creds_data, f, indent=2)
                
        except Exception as e:
            print(f"⚠️ Failed to save authentication information: {e}")
    
    def get_sheet_data(self, sheet_url: str, range_name: str = None) -> Optional[pd.DataFrame]:
        """
        Get Google Sheet data
        
        Args:
            sheet_url: Google Sheet URL
            range_name: data range, like 'Sheet1!A1:Z1000', defaults to get all data
            
        Returns:
            DataFrame: table data, returns None on failure
        """
        if not self.service:
            if not self.authenticate():
                return None
        
        try:
            # Extract Sheet ID
            sheet_id = self._extract_sheet_id(sheet_url)
            if not sheet_id:
                print(f"❌ Cannot extract Sheet ID: {sheet_url}")
                return None
            
            # Get data
            if not range_name:
                # First get Sheet information to determine range
                sheet_metadata = self.service.spreadsheets().get(
                    spreadsheetId=sheet_id
                ).execute()
                
                # Use first sheet
                first_sheet = sheet_metadata['sheets'][0]['properties']['title']
                range_name = first_sheet
            
            result = self.service.spreadsheets().values().get(
                spreadsheetId=sheet_id,
                range=range_name
            ).execute()
            
            values = result.get('values', [])
            if not values:
                print(f"❌ Sheet is empty: {sheet_url}")
                return None
            
            # Convert to DataFrame
            df = pd.DataFrame(values[1:], columns=values[0])
            print(f"✅ Successfully retrieved Sheet data: {len(df)} rows x {len(df.columns)} columns")
            return df
            
        except Exception as e:
            print(f"❌ Failed to retrieve Sheet data: {e}")
            return None
    
    def _extract_sheet_id(self, url: str) -> Optional[str]:
        """Extract Sheet ID from URL"""
        import re
        patterns = [
            r'/spreadsheets/d/([a-zA-Z0-9-_]+)',
            r'spreadsheets/d/([a-zA-Z0-9-_]+)',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                return match.group(1)
        return None
    
    def check_sheet_access(self, sheet_url: str) -> Tuple[bool, str]:
        """
        Check Sheet access permissions
        
        Args:
            sheet_url: Google Sheet URL
            
        Returns:
            Tuple[bool, str]: (whether accessible, status information)
        """
        if not self.service:
            if not self.authenticate():
                return False, "Authentication failed"
        
        try:
            sheet_id = self._extract_sheet_id(sheet_url)
            if not sheet_id:
                return False, f"Cannot extract Sheet ID: {sheet_url}"
            
            # Try to get basic information
            metadata = self.service.spreadsheets().get(
                spreadsheetId=sheet_id,
                fields='properties.title,sheets.properties.title'
            ).execute()
            
            title = metadata['properties']['title']
            sheet_count = len(metadata['sheets'])
            
            return True, f"Sheet accessible: '{title}' ({sheet_count} worksheets)"
            
        except Exception as e:
            if '403' in str(e):
                return False, "Insufficient permissions - need Sheet access permission"
            elif '404' in str(e):
                return False, "Sheet does not exist or is not accessible"
            else:
                return False, f"Access failed: {e}"

# Convenience functions
def fetch_sheet_with_auth(sheet_url: str) -> Optional[pd.DataFrame]:
    """
    Convenience function to get Google Sheet data using authentication
    
    Args:
        sheet_url: Google Sheet URL
        
    Returns:
        DataFrame: table data, returns None on failure
    """
    authenticator = GoogleSheetsAuthenticator()
    return authenticator.get_sheet_data(sheet_url)

def check_sheet_with_auth(sheet_url: str) -> Tuple[bool, str]:
    """
    Convenience function to check Google Sheet access permissions using authentication
    
    Args:
        sheet_url: Google Sheet URL
        
    Returns:
        Tuple[bool, str]: (whether accessible, status information)
    """
    authenticator = GoogleSheetsAuthenticator()
    return authenticator.check_sheet_access(sheet_url) 