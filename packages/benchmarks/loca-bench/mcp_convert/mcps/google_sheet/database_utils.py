"""
Database utilities for Google Sheets MCP Server

Handles data operations for the local Google Sheets implementation.
Stores spreadsheets, sheets, cells, formulas, and formatting data.
"""

import os
import sys
import json
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime
import uuid
import re

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.database import JsonDatabase


def column_letter_to_index(col: str) -> int:
    """Convert column letter (A, B, AA, etc.) to 0-based index"""
    result = 0
    for char in col:
        result = result * 26 + (ord(char.upper()) - ord('A') + 1)
    return result - 1


def column_index_to_letter(index: int) -> str:
    """Convert 0-based column index to letter (A, B, AA, etc.)"""
    result = ""
    index += 1
    while index > 0:
        index -= 1
        result = chr(ord('A') + (index % 26)) + result
        index //= 26
    return result


def parse_a1_notation(range_str: str) -> Tuple[int, int, Optional[int], Optional[int]]:
    """
    Parse A1 notation range to (start_row, start_col, end_row, end_col)
    Returns 0-based indices. end_row and end_col can be None for open-ended ranges.
    Examples: A1, A1:B5, A:A, 1:5
    """
    if ':' in range_str:
        start, end = range_str.split(':', 1)
    else:
        start = end = range_str
    
    # Parse start
    match = re.match(r'^([A-Z]+)?(\d+)?$', start.upper())
    if not match:
        raise ValueError(f"Invalid A1 notation: {start}")
    
    start_col_str, start_row_str = match.groups()
    start_row = int(start_row_str) - 1 if start_row_str else 0
    start_col = column_letter_to_index(start_col_str) if start_col_str else 0
    
    # Parse end
    match = re.match(r'^([A-Z]+)?(\d+)?$', end.upper())
    if not match:
        raise ValueError(f"Invalid A1 notation: {end}")
    
    end_col_str, end_row_str = match.groups()
    end_row = int(end_row_str) - 1 if end_row_str else None
    end_col = column_letter_to_index(end_col_str) if end_col_str else None
    
    return start_row, start_col, end_row, end_col


class GoogleSheetDatabase:
    """Database handler for Google Sheets data"""
    
    def __init__(self, data_dir: str = None):
        """Initialize database with data directory"""
        if data_dir is None:
            # Default to data directory in the same folder as this file
            data_dir = os.path.join(os.path.dirname(__file__), "data")
        
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        
        self.json_db = JsonDatabase(data_dir)
        
        # File mappings
        self.spreadsheets_file = "spreadsheets.json"
        self.sheets_file = "sheets.json"
        self.cells_file = "cells.json"
        self.permissions_file = "permissions.json"
        
        # Initialize files if they don't exist
        self._initialize_files()
    
    def _initialize_files(self):
        """Initialize database files with empty structures"""
        if not self.json_db.file_exists(self.spreadsheets_file):
            self.json_db.save_data(self.spreadsheets_file, {})
        
        if not self.json_db.file_exists(self.sheets_file):
            self.json_db.save_data(self.sheets_file, {})
        
        if not self.json_db.file_exists(self.cells_file):
            self.json_db.save_data(self.cells_file, {})
        
        if not self.json_db.file_exists(self.permissions_file):
            self.json_db.save_data(self.permissions_file, {})
    
    # ==================== Spreadsheet Operations ====================
    
    def create_spreadsheet(self, title: str, folder_id: Optional[str] = None) -> Dict[str, Any]:
        """Create a new spreadsheet"""
        spreadsheet_id = str(uuid.uuid4())
        
        spreadsheet = {
            "spreadsheetId": spreadsheet_id,
            "properties": {
                "title": title,
                "locale": "en_US",
                "autoRecalc": "ON_CHANGE",
                "timeZone": "America/New_York"
            },
            "sheets": [],
            "folder": folder_id or "root",
            "createdTime": datetime.utcnow().isoformat(),
            "modifiedTime": datetime.utcnow().isoformat()
        }
        
        # Save spreadsheet
        spreadsheets = self.json_db.load_data(self.spreadsheets_file)
        spreadsheets[spreadsheet_id] = spreadsheet
        self.json_db.save_data(self.spreadsheets_file, spreadsheets)
        
        # Create default "Sheet1"
        self.create_sheet(spreadsheet_id, "Sheet1")
        
        # Reload and return the updated spreadsheet
        return self.get_spreadsheet(spreadsheet_id)
    
    def get_spreadsheet(self, spreadsheet_id: str) -> Optional[Dict[str, Any]]:
        """Get spreadsheet by ID"""
        spreadsheets = self.json_db.load_data(self.spreadsheets_file)
        return spreadsheets.get(spreadsheet_id)
    
    def list_spreadsheets(self, folder_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all spreadsheets, optionally filtered by folder"""
        spreadsheets = self.json_db.load_data(self.spreadsheets_file)
        result = []
        
        for spreadsheet_id, spreadsheet in spreadsheets.items():
            if folder_id is None or spreadsheet.get("folder") == folder_id:
                result.append({
                    "id": spreadsheet_id,
                    "title": spreadsheet["properties"]["title"]
                })
        
        return result
    
    def update_spreadsheet(self, spreadsheet_id: str, updates: Dict[str, Any]) -> bool:
        """Update spreadsheet metadata"""
        spreadsheets = self.json_db.load_data(self.spreadsheets_file)
        
        if spreadsheet_id not in spreadsheets:
            return False
        
        spreadsheet = spreadsheets[spreadsheet_id]
        spreadsheet.update(updates)
        spreadsheet["modifiedTime"] = datetime.utcnow().isoformat()
        
        self.json_db.save_data(self.spreadsheets_file, spreadsheets)
        return True
    
    # ==================== Sheet Operations ====================
    
    def create_sheet(self, spreadsheet_id: str, title: str, 
                     rows: int = 1000, cols: int = 26) -> Dict[str, Any]:
        """Create a new sheet in a spreadsheet"""
        sheets_data = self.json_db.load_data(self.sheets_file)
        
        # Generate sheet ID
        sheet_id = len([s for s in sheets_data.values() 
                       if s.get("spreadsheetId") == spreadsheet_id])
        
        sheet_key = f"{spreadsheet_id}_{sheet_id}"
        
        sheet = {
            "sheetId": sheet_id,
            "title": title,
            "spreadsheetId": spreadsheet_id,
            "index": sheet_id,
            "sheetType": "GRID",
            "gridProperties": {
                "rowCount": rows,
                "columnCount": cols
            }
        }
        
        sheets_data[sheet_key] = sheet
        self.json_db.save_data(self.sheets_file, sheets_data)
        
        # Update spreadsheet's sheets list
        spreadsheet = self.get_spreadsheet(spreadsheet_id)
        if spreadsheet:
            spreadsheet["sheets"].append({
                "properties": sheet
            })
            self.update_spreadsheet(spreadsheet_id, spreadsheet)
        
        return sheet
    
    def get_sheet(self, spreadsheet_id: str, sheet_name: str) -> Optional[Dict[str, Any]]:
        """Get sheet by name"""
        sheets_data = self.json_db.load_data(self.sheets_file)
        
        for sheet in sheets_data.values():
            if (sheet.get("spreadsheetId") == spreadsheet_id and 
                sheet.get("title") == sheet_name):
                return sheet
        
        return None
    
    def get_sheet_by_id(self, spreadsheet_id: str, sheet_id: int) -> Optional[Dict[str, Any]]:
        """Get sheet by ID"""
        sheets_data = self.json_db.load_data(self.sheets_file)
        sheet_key = f"{spreadsheet_id}_{sheet_id}"
        return sheets_data.get(sheet_key)
    
    def list_sheets(self, spreadsheet_id: str) -> List[str]:
        """List all sheet names in a spreadsheet"""
        sheets_data = self.json_db.load_data(self.sheets_file)
        
        sheet_names = []
        for sheet in sheets_data.values():
            if sheet.get("spreadsheetId") == spreadsheet_id:
                sheet_names.append(sheet["title"])
        
        return sorted(sheet_names, key=lambda n: self.get_sheet(spreadsheet_id, n)["index"])
    
    def rename_sheet(self, spreadsheet_id: str, old_name: str, new_name: str) -> bool:
        """Rename a sheet"""
        sheet = self.get_sheet(spreadsheet_id, old_name)
        if not sheet:
            return False
        
        sheets_data = self.json_db.load_data(self.sheets_file)
        sheet_key = f"{spreadsheet_id}_{sheet['sheetId']}"
        
        sheets_data[sheet_key]["title"] = new_name
        self.json_db.save_data(self.sheets_file, sheets_data)
        
        # Update spreadsheet metadata
        spreadsheet = self.get_spreadsheet(spreadsheet_id)
        if spreadsheet:
            for s in spreadsheet["sheets"]:
                if s["properties"]["sheetId"] == sheet["sheetId"]:
                    s["properties"]["title"] = new_name
            self.update_spreadsheet(spreadsheet_id, spreadsheet)
        
        # Update cells.json - rename all cell keys that use the old sheet name
        cells_data = self.json_db.load_data(self.cells_file)
        old_prefix = f"{spreadsheet_id}_{old_name}_"
        new_prefix = f"{spreadsheet_id}_{new_name}_"
        
        # Create new cells dictionary with updated keys
        updated_cells = {}
        for cell_key, cell_value in cells_data.items():
            if cell_key.startswith(old_prefix):
                # Replace old key with new key
                new_key = cell_key.replace(old_prefix, new_prefix, 1)
                updated_cells[new_key] = cell_value
            else:
                updated_cells[cell_key] = cell_value
        
        self.json_db.save_data(self.cells_file, updated_cells)
        
        return True
    
    def copy_sheet(self, src_spreadsheet: str, src_sheet: str,
                   dst_spreadsheet: str, dst_sheet: str) -> Dict[str, Any]:
        """Copy a sheet from one spreadsheet to another"""
        # Get source sheet and its data
        src_sheet_data = self.get_sheet(src_spreadsheet, src_sheet)
        if not src_sheet_data:
            return {"error": f"Source sheet '{src_sheet}' not found"}
        
        # Get all cells from source sheet
        src_cells = self.get_all_cells(src_spreadsheet, src_sheet)
        
        # Create new sheet in destination
        new_sheet = self.create_sheet(
            dst_spreadsheet, 
            dst_sheet,
            src_sheet_data["gridProperties"]["rowCount"],
            src_sheet_data["gridProperties"]["columnCount"]
        )
        
        # Copy all cells
        for cell_key, cell_data in src_cells.items():
            new_cell_key = cell_key.replace(
                f"{src_spreadsheet}_{src_sheet}",
                f"{dst_spreadsheet}_{dst_sheet}"
            )
            cells = self.json_db.load_data(self.cells_file)
            cells[new_cell_key] = cell_data
            self.json_db.save_data(self.cells_file, cells)
        
        return {"sheetId": new_sheet["sheetId"], "title": dst_sheet}
    
    def add_rows(self, spreadsheet_id: str, sheet_name: str, 
                 count: int, start_row: Optional[int] = None) -> bool:
        """Add rows to a sheet"""
        sheet = self.get_sheet(spreadsheet_id, sheet_name)
        if not sheet:
            return False
        
        # Update grid properties
        sheets_data = self.json_db.load_data(self.sheets_file)
        sheet_key = f"{spreadsheet_id}_{sheet['sheetId']}"
        sheets_data[sheet_key]["gridProperties"]["rowCount"] += count
        self.json_db.save_data(self.sheets_file, sheets_data)
        
        # If inserting in the middle, shift existing rows
        if start_row is not None:
            cells = self.json_db.load_data(self.cells_file)
            cells_to_update = {}
            
            for cell_key, cell_data in cells.items():
                if cell_key.startswith(f"{spreadsheet_id}_{sheet_name}_"):
                    parts = cell_key.split('_')
                    if len(parts) >= 4:
                        row = int(parts[-2])
                        if row >= start_row:
                            # Create new key with shifted row
                            new_key = f"{spreadsheet_id}_{sheet_name}_{row + count}_{parts[-1]}"
                            cells_to_update[new_key] = cell_data
                            cells_to_update[cell_key] = None  # Mark for deletion
            
            # Apply updates
            for key, value in cells_to_update.items():
                if value is None:
                    cells.pop(key, None)
                else:
                    cells[key] = value
            
            self.json_db.save_data(self.cells_file, cells)
        
        return True
    
    def add_columns(self, spreadsheet_id: str, sheet_name: str,
                    count: int, start_column: Optional[int] = None) -> bool:
        """Add columns to a sheet"""
        sheet = self.get_sheet(spreadsheet_id, sheet_name)
        if not sheet:
            return False
        
        # Update grid properties
        sheets_data = self.json_db.load_data(self.sheets_file)
        sheet_key = f"{spreadsheet_id}_{sheet['sheetId']}"
        sheets_data[sheet_key]["gridProperties"]["columnCount"] += count
        self.json_db.save_data(self.sheets_file, sheets_data)
        
        # If inserting in the middle, shift existing columns
        if start_column is not None:
            cells = self.json_db.load_data(self.cells_file)
            cells_to_update = {}
            
            for cell_key, cell_data in cells.items():
                if cell_key.startswith(f"{spreadsheet_id}_{sheet_name}_"):
                    parts = cell_key.split('_')
                    if len(parts) >= 4:
                        col = int(parts[-1])
                        if col >= start_column:
                            # Create new key with shifted column
                            new_key = f"{spreadsheet_id}_{sheet_name}_{parts[-2]}_{col + count}"
                            cells_to_update[new_key] = cell_data
                            cells_to_update[cell_key] = None  # Mark for deletion
            
            # Apply updates
            for key, value in cells_to_update.items():
                if value is None:
                    cells.pop(key, None)
                else:
                    cells[key] = value
            
            self.json_db.save_data(self.cells_file, cells)
        
        return True
    
    # ==================== Cell Operations ====================
    
    def get_cell_key(self, spreadsheet_id: str, sheet_name: str, 
                     row: int, col: int) -> str:
        """Generate cell key for storage"""
        return f"{spreadsheet_id}_{sheet_name}_{row}_{col}"
    
    def get_cells(self, spreadsheet_id: str, sheet_name: str,
                  range_notation: Optional[str] = None) -> Dict[str, Any]:
        """Get cells in a range"""
        cells = self.json_db.load_data(self.cells_file)
        
        # Parse range if provided
        if range_notation:
            try:
                start_row, start_col, end_row, end_col = parse_a1_notation(range_notation)
            except ValueError:
                return {"error": f"Invalid range notation: {range_notation}"}
        else:
            # Get all cells in sheet
            sheet = self.get_sheet(spreadsheet_id, sheet_name)
            if not sheet:
                return {"error": f"Sheet '{sheet_name}' not found"}
            
            start_row, start_col = 0, 0
            end_row = sheet["gridProperties"]["rowCount"] - 1
            end_col = sheet["gridProperties"]["columnCount"] - 1
        
        # Collect cells in range
        result_cells = {}
        for cell_key, cell_data in cells.items():
            if cell_key.startswith(f"{spreadsheet_id}_{sheet_name}_"):
                parts = cell_key.split('_')
                if len(parts) >= 4:
                    row, col = int(parts[-2]), int(parts[-1])
                    
                    if row >= start_row and col >= start_col:
                        if (end_row is None or row <= end_row) and \
                           (end_col is None or col <= end_col):
                            result_cells[cell_key] = cell_data
        
        return result_cells
    
    def get_all_cells(self, spreadsheet_id: str, sheet_name: str) -> Dict[str, Any]:
        """Get all cells in a sheet"""
        cells = self.json_db.load_data(self.cells_file)
        return {k: v for k, v in cells.items() 
                if k.startswith(f"{spreadsheet_id}_{sheet_name}_")}
    
    def get_values(self, spreadsheet_id: str, sheet_name: str,
                   range_notation: Optional[str] = None) -> List[List[Any]]:
        """Get cell values as a 2D array"""
        cells_dict = self.get_cells(spreadsheet_id, sheet_name, range_notation)
        
        if "error" in cells_dict:
            return []
        
        if not cells_dict:
            return []
        
        # Find dimensions
        max_row = -1
        max_col = -1
        cell_positions = {}
        
        for cell_key, cell_data in cells_dict.items():
            parts = cell_key.split('_')
            if len(parts) >= 4:
                row, col = int(parts[-2]), int(parts[-1])
                max_row = max(max_row, row)
                max_col = max(max_col, col)
                cell_positions[(row, col)] = cell_data.get("value", "")
        
        if max_row == -1 or max_col == -1:
            return []
        
        # Build 2D array
        result = []
        for row in range(max_row + 1):
            row_data = []
            for col in range(max_col + 1):
                row_data.append(cell_positions.get((row, col), ""))
            result.append(row_data)
        
        return result
    
    def get_formulas(self, spreadsheet_id: str, sheet_name: str,
                     range_notation: Optional[str] = None) -> List[List[Any]]:
        """Get cell formulas as a 2D array"""
        cells_dict = self.get_cells(spreadsheet_id, sheet_name, range_notation)
        
        if "error" in cells_dict:
            return []
        
        if not cells_dict:
            return []
        
        # Find dimensions
        max_row = -1
        max_col = -1
        cell_positions = {}
        
        for cell_key, cell_data in cells_dict.items():
            parts = cell_key.split('_')
            if len(parts) >= 4:
                row, col = int(parts[-2]), int(parts[-1])
                max_row = max(max_row, row)
                max_col = max(max_col, col)
                formula = cell_data.get("formula", "")
                if not formula:
                    formula = cell_data.get("value", "")
                cell_positions[(row, col)] = formula
        
        if max_row == -1 or max_col == -1:
            return []
        
        # Build 2D array
        result = []
        for row in range(max_row + 1):
            row_data = []
            for col in range(max_col + 1):
                row_data.append(cell_positions.get((row, col), ""))
            result.append(row_data)
        
        return result
    
    def update_cells(self, spreadsheet_id: str, sheet_name: str,
                     range_notation: str, values: List[List[Any]]) -> Dict[str, Any]:
        """Update cells with values"""
        try:
            start_row, start_col, _, _ = parse_a1_notation(range_notation)
        except ValueError as e:
            return {"error": str(e)}
        
        cells = self.json_db.load_data(self.cells_file)
        updated_cells = 0
        
        for row_idx, row_data in enumerate(values):
            for col_idx, value in enumerate(row_data):
                cell_row = start_row + row_idx
                cell_col = start_col + col_idx
                
                cell_key = self.get_cell_key(spreadsheet_id, sheet_name, cell_row, cell_col)
                
                # Determine if value is a formula
                is_formula = isinstance(value, str) and value.startswith('=')
                
                cell_data = {
                    "value": value,
                    "formula": value if is_formula else "",
                    "formatted_value": str(value),
                    "updated": datetime.utcnow().isoformat()
                }
                
                cells[cell_key] = cell_data
                updated_cells += 1
        
        self.json_db.save_data(self.cells_file, cells)
        
        return {
            "spreadsheetId": spreadsheet_id,
            "updatedCells": updated_cells,
            "updatedRows": len(values),
            "updatedColumns": max(len(row) for row in values) if values else 0
        }
    
    def batch_update_cells(self, spreadsheet_id: str, sheet_name: str,
                           ranges: Dict[str, List[List[Any]]]) -> Dict[str, Any]:
        """Batch update multiple ranges"""
        total_updated = 0
        responses = []
        
        for range_notation, values in ranges.items():
            result = self.update_cells(spreadsheet_id, sheet_name, range_notation, values)
            if "error" not in result:
                total_updated += result.get("updatedCells", 0)
                responses.append({
                    "range": f"{sheet_name}!{range_notation}",
                    "updatedCells": result.get("updatedCells", 0)
                })
        
        return {
            "spreadsheetId": spreadsheet_id,
            "totalUpdatedCells": total_updated,
            "responses": responses
        }
    
    # ==================== Permission Operations ====================
    
    def share_spreadsheet(self, spreadsheet_id: str, recipients: List[Dict[str, str]],
                         send_notification: bool = True) -> Dict[str, List[Dict[str, Any]]]:
        """Share a spreadsheet with users"""
        permissions = self.json_db.load_data(self.permissions_file)
        
        if spreadsheet_id not in permissions:
            permissions[spreadsheet_id] = []
        
        successes = []
        failures = []
        
        for recipient in recipients:
            email = recipient.get("email_address")
            role = recipient.get("role", "writer")
            
            if not email:
                failures.append({
                    "email_address": None,
                    "error": "Missing email_address"
                })
                continue
            
            if role not in ["reader", "commenter", "writer"]:
                failures.append({
                    "email_address": email,
                    "error": f"Invalid role '{role}'"
                })
                continue
            
            permission = {
                "id": str(uuid.uuid4()),
                "email_address": email,
                "role": role,
                "created": datetime.utcnow().isoformat()
            }
            
            permissions[spreadsheet_id].append(permission)
            successes.append({
                "email_address": email,
                "role": role,
                "permissionId": permission["id"]
            })
        
        self.json_db.save_data(self.permissions_file, permissions)
        
        return {"successes": successes, "failures": failures}
    
    # ==================== Utility Methods ====================
    
    def get_database_stats(self) -> Dict[str, Any]:
        """Get database statistics"""
        spreadsheets = self.json_db.load_data(self.spreadsheets_file)
        sheets = self.json_db.load_data(self.sheets_file)
        cells = self.json_db.load_data(self.cells_file)
        
        return {
            "total_spreadsheets": len(spreadsheets),
            "total_sheets": len(sheets),
            "total_cells": len(cells),
            "files": {
                self.spreadsheets_file: {
                    "size_bytes": self.json_db.get_file_size(self.spreadsheets_file),
                    "exists": True
                },
                self.sheets_file: {
                    "size_bytes": self.json_db.get_file_size(self.sheets_file),
                    "exists": True
                },
                self.cells_file: {
                    "size_bytes": self.json_db.get_file_size(self.cells_file),
                    "exists": True
                }
            }
        }
