#!/usr/bin/env python3
"""
Google Sheets MCP Server

A Model Context Protocol server that provides Google Sheets functionality
using local JSON files as the database instead of connecting to external APIs.

Uses the common MCP framework for simplified development.
"""

import asyncio
import sys
import os

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.mcp.server_base import BaseMCPServer
from common.mcp.tools import ToolRegistry
from mcps.google_sheet.database_utils import GoogleSheetDatabase


class GoogleSheetMCPServer(BaseMCPServer):
    """Google Sheets MCP server implementation"""
    
    def __init__(self):
        super().__init__("google-sheet", "1.0.0")
        
        # Get data directory from environment variable or use default
        data_dir = os.environ.get('GOOGLE_SHEET_DATA_DIR')
        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if data_dir:
            if not quiet:
                print(f"Using Google Sheets data directory from environment: {data_dir}", file=sys.stderr)
            os.makedirs(data_dir, exist_ok=True)
        else:
            # Use default data directory if not specified
            data_dir = os.path.join(os.path.dirname(__file__), "data")
            if not quiet:
                print(f"Using default Google Sheets data directory: {data_dir}", file=sys.stderr)
        
        self.db = GoogleSheetDatabase(data_dir=data_dir)
        self.tool_registry = ToolRegistry()
        self.setup_tools()
    
    def setup_tools(self):
        """Setup all Google Sheets tools"""
        
        # Tool 1: get_sheet_data
        self.tool_registry.register(
            name="get_sheet_data",
            description="Get data from a specific sheet in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet (found in the URL)"
                    },
                    "sheet": {
                        "type": "string",
                        "description": "The name of the sheet"
                    },
                    "range": {
                        "type": "string",
                        "description": "Optional cell range in A1 notation (e.g., 'A1:C10'). If not provided, gets all data."
                    },
                    "include_grid_data": {
                        "type": "boolean",
                        "description": "If True, includes cell formatting and other metadata in the response. Note: Setting this to True will significantly increase the response size and token usage when parsing the response, as it includes detailed cell formatting information. Default is False (returns values only, more efficient).",
                        "default": False
                    }
                },
                "required": ["spreadsheet_id", "sheet"]
            },
            handler=self.get_sheet_data
        )
        
        # Tool 2: get_sheet_formulas
        self.tool_registry.register(
            name="get_sheet_formulas",
            description="Get formulas from a specific sheet in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet (found in the URL)"
                    },
                    "sheet": {
                        "type": "string",
                        "description": "The name of the sheet"
                    },
                    "range": {
                        "type": "string",
                        "description": "Optional cell range in A1 notation (e.g., 'A1:C10'). If not provided, gets all formulas from the sheet."
                    }
                },
                "required": ["spreadsheet_id", "sheet"]
            },
            handler=self.get_sheet_formulas
        )
        
        # Tool 3: update_cells
        self.tool_registry.register(
            name="update_cells",
            description="Update cells in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet (found in the URL)"
                    },
                    "sheet": {
                        "type": "string",
                        "description": "The name of the sheet"
                    },
                    "range": {
                        "type": "string",
                        "description": "Cell range in A1 notation (e.g., 'A1:C10')"
                    },
                    "data": {
                        "type": "array",
                        "description": "2D array of values to update",
                        "items": {
                            "type": "array"
                        }
                    }
                },
                "required": ["spreadsheet_id", "sheet", "range", "data"]
            },
            handler=self.update_cells
        )
        
        # Tool 4: batch_update_cells
        self.tool_registry.register(
            name="batch_update_cells",
            description="Batch update multiple ranges in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet (found in the URL)"
                    },
                    "sheet": {
                        "type": "string",
                        "description": "The name of the sheet"
                    },
                    "ranges": {
                        "type": "object",
                        "description": "Dictionary mapping range strings to 2D arrays of values. e.g., {'A1:B2': [[1, 2], [3, 4]], 'D1:E2': [['a', 'b'], ['c', 'd']]}"
                    }
                },
                "required": ["spreadsheet_id", "sheet", "ranges"]
            },
            handler=self.batch_update_cells
        )
        
        # Tool 5: add_rows
        self.tool_registry.register(
            name="add_rows",
            description="Add rows to a sheet in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet (found in the URL)"
                    },
                    "sheet": {
                        "type": "string",
                        "description": "The name of the sheet"
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of rows to add"
                    },
                    "start_row": {
                        "type": "integer",
                        "description": "0-based row index to start adding. If not provided, adds at the beginning."
                    }
                },
                "required": ["spreadsheet_id", "sheet", "count"]
            },
            handler=self.add_rows
        )
        
        # Tool 6: add_columns
        self.tool_registry.register(
            name="add_columns",
            description="Add columns to a sheet in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet (found in the URL)"
                    },
                    "sheet": {
                        "type": "string",
                        "description": "The name of the sheet"
                    },
                    "count": {
                        "type": "integer",
                        "description": "Number of columns to add"
                    },
                    "start_column": {
                        "type": "integer",
                        "description": "0-based column index to start adding. If not provided, adds at the beginning."
                    }
                },
                "required": ["spreadsheet_id", "sheet", "count"]
            },
            handler=self.add_columns
        )
        
        # Tool 7: list_sheets
        self.tool_registry.register(
            name="list_sheets",
            description="List all sheets in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet (found in the URL)"
                    }
                },
                "required": ["spreadsheet_id"]
            },
            handler=self.list_sheets
        )
        
        # Tool 8: copy_sheet
        self.tool_registry.register(
            name="copy_sheet",
            description="Copy a sheet from one spreadsheet to another.",
            input_schema={
                "type": "object",
                "properties": {
                    "src_spreadsheet": {
                        "type": "string",
                        "description": "Source spreadsheet ID"
                    },
                    "src_sheet": {
                        "type": "string",
                        "description": "Source sheet name"
                    },
                    "dst_spreadsheet": {
                        "type": "string",
                        "description": "Destination spreadsheet ID"
                    },
                    "dst_sheet": {
                        "type": "string",
                        "description": "Destination sheet name"
                    }
                },
                "required": ["src_spreadsheet", "src_sheet", "dst_spreadsheet", "dst_sheet"]
            },
            handler=self.copy_sheet
        )
        
        # Tool 9: rename_sheet
        self.tool_registry.register(
            name="rename_sheet",
            description="Rename a sheet in a Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet": {
                        "type": "string",
                        "description": "Spreadsheet ID"
                    },
                    "sheet": {
                        "type": "string",
                        "description": "Current sheet name"
                    },
                    "new_name": {
                        "type": "string",
                        "description": "New sheet name"
                    }
                },
                "required": ["spreadsheet", "sheet", "new_name"]
            },
            handler=self.rename_sheet
        )
        
        # Tool 10: get_multiple_sheet_data
        self.tool_registry.register(
            name="get_multiple_sheet_data",
            description="Get data from multiple specific ranges in Google Spreadsheets.",
            input_schema={
                "type": "object",
                "properties": {
                    "queries": {
                        "type": "array",
                        "description": "A list of dictionaries, each specifying a query. Each dictionary should have 'spreadsheet_id', 'sheet', and 'range' keys. Example: [{'spreadsheet_id': 'abc', 'sheet': 'Sheet1', 'range': 'A1:B5'}, {'spreadsheet_id': 'xyz', 'sheet': 'Data', 'range': 'C1:C10'}]",
                        "items": {
                            "type": "object",
                            "properties": {
                                "spreadsheet_id": {"type": "string"},
                                "sheet": {"type": "string"},
                                "range": {"type": "string"}
                            },
                            "required": ["spreadsheet_id", "sheet", "range"]
                        }
                    }
                },
                "required": ["queries"]
            },
            handler=self.get_multiple_sheet_data
        )
        
        # Tool 11: get_multiple_spreadsheet_summary
        self.tool_registry.register(
            name="get_multiple_spreadsheet_summary",
            description="Get a summary of multiple Google Spreadsheets, including sheet names, headers, and the first few rows of data for each sheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_ids": {
                        "type": "array",
                        "description": "A list of spreadsheet IDs to summarize.",
                        "items": {"type": "string"}
                    },
                    "rows_to_fetch": {
                        "type": "integer",
                        "description": "The number of rows (including header) to fetch for the summary (default: 5).",
                        "default": 5
                    }
                },
                "required": ["spreadsheet_ids"]
            },
            handler=self.get_multiple_spreadsheet_summary
        )
        
        # Tool 12: create_spreadsheet
        self.tool_registry.register(
            name="create_spreadsheet",
            description="Create a new Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The title of the new spreadsheet"
                    }
                },
                "required": ["title"]
            },
            handler=self.create_spreadsheet
        )
        
        # Tool 13: create_sheet
        self.tool_registry.register(
            name="create_sheet",
            description="Create a new sheet tab in an existing Google Spreadsheet.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet"
                    },
                    "title": {
                        "type": "string",
                        "description": "The title for the new sheet"
                    }
                },
                "required": ["spreadsheet_id", "title"]
            },
            handler=self.create_sheet
        )
        
        # Tool 14: list_spreadsheets
        self.tool_registry.register(
            name="list_spreadsheets",
            description="List all spreadsheets in the configured Google Drive folder. If no folder is configured, lists spreadsheets from 'My Drive'.",
            input_schema={
                "type": "object",
                "properties": {}
            },
            handler=self.list_spreadsheets
        )
        
        # Tool 15: share_spreadsheet
        self.tool_registry.register(
            name="share_spreadsheet",
            description="Share a Google Spreadsheet with multiple users via email, assigning specific roles.",
            input_schema={
                "type": "object",
                "properties": {
                    "spreadsheet_id": {
                        "type": "string",
                        "description": "The ID of the spreadsheet to share."
                    },
                    "recipients": {
                        "type": "array",
                        "description": "A list of dictionaries, each containing 'email_address' and 'role'. The role should be one of: 'reader', 'commenter', 'writer'. Example: [{'email_address': 'user1@example.com', 'role': 'writer'}, {'email_address': 'user2@example.com', 'role': 'reader'}]",
                        "items": {
                            "type": "object",
                            "properties": {
                                "email_address": {"type": "string"},
                                "role": {"type": "string", "enum": ["reader", "commenter", "writer"]}
                            },
                            "required": ["email_address", "role"]
                        }
                    },
                    "send_notification": {
                        "type": "boolean",
                        "description": "Whether to send a notification email to the users. Defaults to True.",
                        "default": True
                    }
                },
                "required": ["spreadsheet_id", "recipients"]
            },
            handler=self.share_spreadsheet
        )
    
    async def list_tools(self):
        """List all available tools"""
        return self.tool_registry.get_tool_definitions()
    
    async def call_tool(self, name: str, arguments: dict):
        """Handle tool calls using the registry"""
        return await self.tool_registry.call_tool(name, arguments)
    
    # ==================== Tool Handlers ====================
    
    async def get_sheet_data(self, args: dict):
        """Get data from a specific sheet"""
        spreadsheet_id = args["spreadsheet_id"]
        sheet = args["sheet"]
        range_notation = args.get("range")
        include_grid_data = args.get("include_grid_data", False)
        
        # Construct the range
        full_range = f"{sheet}!{range_notation}" if range_notation else sheet
        
        if include_grid_data:
            # Return full grid data with metadata (more complex structure)
            spreadsheet = self.db.get_spreadsheet(spreadsheet_id)
            if not spreadsheet:
                return self.create_text_response(f"Spreadsheet '{spreadsheet_id}' not found")
            
            sheet_data = self.db.get_sheet(spreadsheet_id, sheet)
            if not sheet_data:
                return self.create_text_response(f"Sheet '{sheet}' not found")
            
            # Get cell data
            cells_dict = self.db.get_cells(spreadsheet_id, sheet, range_notation)
            
            # Build grid data structure
            result = {
                "spreadsheetId": spreadsheet_id,
                "properties": spreadsheet["properties"],
                "sheets": [{
                    "properties": sheet_data,
                    "data": [{
                        "rowData": []
                    }]
                }]
            }
            
            return self.create_json_response(result)
        else:
            # Return values only (more efficient)
            # First validate spreadsheet and sheet exist
            spreadsheet = self.db.get_spreadsheet(spreadsheet_id)
            if not spreadsheet:
                return self.create_text_response(f"Spreadsheet '{spreadsheet_id}' not found")
            
            sheet_data = self.db.get_sheet(spreadsheet_id, sheet)
            if not sheet_data:
                return self.create_text_response(f"Sheet '{sheet}' not found")
            
            values = self.db.get_values(spreadsheet_id, sheet, range_notation)
            
            result = {
                "spreadsheetId": spreadsheet_id,
                "valueRanges": [{
                    "range": full_range,
                    "values": values
                }]
            }
            
            return self.create_json_response(result)
    
    async def get_sheet_formulas(self, args: dict):
        """Get formulas from a specific sheet"""
        spreadsheet_id = args["spreadsheet_id"]
        sheet = args["sheet"]
        range_notation = args.get("range")
        
        formulas = self.db.get_formulas(spreadsheet_id, sheet, range_notation)
        
        return self.create_json_response(formulas)
    
    async def update_cells(self, args: dict):
        """Update cells in a spreadsheet"""
        spreadsheet_id = args["spreadsheet_id"]
        sheet = args["sheet"]
        range_notation = args["range"]
        data = args["data"]
        
        # Validate spreadsheet and sheet exist
        spreadsheet = self.db.get_spreadsheet(spreadsheet_id)
        if not spreadsheet:
            return self.create_text_response(f"Spreadsheet '{spreadsheet_id}' not found")
        
        sheet_data = self.db.get_sheet(spreadsheet_id, sheet)
        if not sheet_data:
            return self.create_text_response(f"Sheet '{sheet}' not found")
        
        result = self.db.update_cells(spreadsheet_id, sheet, range_notation, data)
        
        if "error" in result:
            return self.create_text_response(f"Error updating cells: {result['error']}")
        
        return self.create_json_response(result)
    
    async def batch_update_cells(self, args: dict):
        """Batch update multiple ranges"""
        spreadsheet_id = args["spreadsheet_id"]
        sheet = args["sheet"]
        ranges = args["ranges"]
        
        result = self.db.batch_update_cells(spreadsheet_id, sheet, ranges)
        
        return self.create_json_response(result)
    
    async def add_rows(self, args: dict):
        """Add rows to a sheet"""
        spreadsheet_id = args["spreadsheet_id"]
        sheet = args["sheet"]
        count = args["count"]
        start_row = args.get("start_row")
        
        success = self.db.add_rows(spreadsheet_id, sheet, count, start_row)
        
        if not success:
            return self.create_text_response(f"Failed to add rows to sheet '{sheet}'")
        
        result = {
            "spreadsheetId": spreadsheet_id,
            "replies": [{
                "insertDimension": {
                    "dimension": "ROWS",
                    "insertedRows": count
                }
            }]
        }
        
        return self.create_json_response(result)
    
    async def add_columns(self, args: dict):
        """Add columns to a sheet"""
        spreadsheet_id = args["spreadsheet_id"]
        sheet = args["sheet"]
        count = args["count"]
        start_column = args.get("start_column")
        
        success = self.db.add_columns(spreadsheet_id, sheet, count, start_column)
        
        if not success:
            return self.create_text_response(f"Failed to add columns to sheet '{sheet}'")
        
        result = {
            "spreadsheetId": spreadsheet_id,
            "replies": [{
                "insertDimension": {
                    "dimension": "COLUMNS",
                    "insertedColumns": count
                }
            }]
        }
        
        return self.create_json_response(result)
    
    async def list_sheets(self, args: dict):
        """List all sheets in a spreadsheet"""
        spreadsheet_id = args["spreadsheet_id"]
        
        sheet_names = self.db.list_sheets(spreadsheet_id)
        
        return self.create_json_response(sheet_names)
    
    async def copy_sheet(self, args: dict):
        """Copy a sheet from one spreadsheet to another"""
        src_spreadsheet = args["src_spreadsheet"]
        src_sheet = args["src_sheet"]
        dst_spreadsheet = args["dst_spreadsheet"]
        dst_sheet = args["dst_sheet"]
        
        result = self.db.copy_sheet(src_spreadsheet, src_sheet, dst_spreadsheet, dst_sheet)
        
        if "error" in result:
            return self.create_text_response(result["error"])
        
        return self.create_json_response(result)
    
    async def rename_sheet(self, args: dict):
        """Rename a sheet"""
        spreadsheet = args["spreadsheet"]
        sheet = args["sheet"]
        new_name = args["new_name"]
        
        success = self.db.rename_sheet(spreadsheet, sheet, new_name)
        
        if not success:
            return self.create_text_response(f"Failed to rename sheet '{sheet}'")
        
        result = {
            "spreadsheetId": spreadsheet,
            "replies": [{
                "updateSheetProperties": {
                    "properties": {
                        "title": new_name
                    }
                }
            }]
        }
        
        return self.create_json_response(result)
    
    async def get_multiple_sheet_data(self, args: dict):
        """Get data from multiple sheet ranges"""
        queries = args["queries"]
        results = []
        
        for query in queries:
            spreadsheet_id = query.get("spreadsheet_id")
            sheet = query.get("sheet")
            range_str = query.get("range")
            
            if not all([spreadsheet_id, sheet, range_str]):
                results.append({
                    **query,
                    "error": "Missing required keys (spreadsheet_id, sheet, range)"
                })
                continue
            
            try:
                values = self.db.get_values(spreadsheet_id, sheet, range_str)
                results.append({
                    **query,
                    "data": values
                })
            except Exception as e:
                results.append({
                    **query,
                    "error": str(e)
                })
        
        return self.create_json_response(results)
    
    async def get_multiple_spreadsheet_summary(self, args: dict):
        """Get summary of multiple spreadsheets"""
        spreadsheet_ids = args["spreadsheet_ids"]
        rows_to_fetch = args.get("rows_to_fetch", 5)
        summaries = []
        
        for spreadsheet_id in spreadsheet_ids:
            summary_data = {
                "spreadsheet_id": spreadsheet_id,
                "title": None,
                "sheets": [],
                "error": None
            }
            
            try:
                spreadsheet = self.db.get_spreadsheet(spreadsheet_id)
                if not spreadsheet:
                    summary_data["error"] = f"Spreadsheet '{spreadsheet_id}' not found"
                    summaries.append(summary_data)
                    continue
                
                summary_data["title"] = spreadsheet["properties"]["title"]
                
                sheet_names = self.db.list_sheets(spreadsheet_id)
                sheet_summaries = []
                
                for sheet_title in sheet_names:
                    sheet = self.db.get_sheet(spreadsheet_id, sheet_title)
                    sheet_summary = {
                        "title": sheet_title,
                        "sheet_id": sheet["sheetId"] if sheet else None,
                        "headers": [],
                        "first_rows": [],
                        "error": None
                    }
                    
                    try:
                        # Fetch first N rows
                        values = self.db.get_values(spreadsheet_id, sheet_title, f"A1:{rows_to_fetch}")
                        
                        if values:
                            sheet_summary["headers"] = values[0] if len(values) > 0 else []
                            sheet_summary["first_rows"] = values[1:] if len(values) > 1 else []
                    except Exception as sheet_e:
                        sheet_summary["error"] = f"Error fetching data: {str(sheet_e)}"
                    
                    sheet_summaries.append(sheet_summary)
                
                summary_data["sheets"] = sheet_summaries
            except Exception as e:
                summary_data["error"] = f"Error fetching spreadsheet: {str(e)}"
            
            summaries.append(summary_data)
        
        return self.create_json_response(summaries)
    
    async def create_spreadsheet(self, args: dict):
        """Create a new spreadsheet"""
        title = args["title"]
        
        spreadsheet = self.db.create_spreadsheet(title)
        
        result = {
            "spreadsheetId": spreadsheet["spreadsheetId"],
            "title": title,
            "folder": spreadsheet.get("folder", "root")
        }
        
        return self.create_json_response(result)
    
    async def create_sheet(self, args: dict):
        """Create a new sheet in a spreadsheet"""
        spreadsheet_id = args["spreadsheet_id"]
        title = args["title"]
        
        sheet = self.db.create_sheet(spreadsheet_id, title)
        
        result = {
            "sheetId": sheet["sheetId"],
            "title": sheet["title"],
            "index": sheet.get("index"),
            "spreadsheetId": spreadsheet_id
        }
        
        return self.create_json_response(result)
    
    async def list_spreadsheets(self, args: dict):
        """List all spreadsheets"""
        spreadsheets = self.db.list_spreadsheets()
        
        return self.create_json_response(spreadsheets)
    
    async def share_spreadsheet(self, args: dict):
        """Share a spreadsheet with users"""
        spreadsheet_id = args["spreadsheet_id"]
        recipients = args["recipients"]
        send_notification = args.get("send_notification", True)
        
        result = self.db.share_spreadsheet(spreadsheet_id, recipients, send_notification)
        
        return self.create_json_response(result)


async def main():
    """Main entry point"""
    server = GoogleSheetMCPServer()
    await server.run()


if __name__ == "__main__":
    asyncio.run(main())
