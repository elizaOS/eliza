#!/usr/bin/env python3
"""
Test file for the Google Sheets MCP Server

Tests all tools and database functionality using the common testing framework.
"""

import pytest
import asyncio
import json
import os
import sys
from typing import Dict, Any

# Add project root to path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)

from common.testing import BaseMCPTest, BaseDataTest, MCPServerTester
from common.testing.data_validation import DataValidator
from mcps.google_sheet.server import GoogleSheetMCPServer
from mcps.google_sheet.database_utils import GoogleSheetDatabase
import mcp.types as types


class TestGoogleSheetDatabase(BaseDataTest):
    """Test the Google Sheets database utilities"""
    
    @pytest.fixture
    def database_instance(self):
        """Return Google Sheets database instance"""
        return GoogleSheetDatabase()
    
    def test_create_spreadsheet(self, database_instance):
        """Test creating a new spreadsheet"""
        spreadsheet = database_instance.create_spreadsheet("Test Spreadsheet")
        
        assert "spreadsheetId" in spreadsheet
        assert spreadsheet["properties"]["title"] == "Test Spreadsheet"
        assert len(spreadsheet["sheets"]) > 0  # Should have default Sheet1
    
    def test_get_spreadsheet(self, database_instance):
        """Test getting a spreadsheet"""
        spreadsheet = database_instance.create_spreadsheet("Test Get")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        retrieved = database_instance.get_spreadsheet(spreadsheet_id)
        assert retrieved is not None
        assert retrieved["spreadsheetId"] == spreadsheet_id
    
    def test_list_spreadsheets(self, database_instance):
        """Test listing spreadsheets"""
        # Create a couple of spreadsheets
        database_instance.create_spreadsheet("Test List 1")
        database_instance.create_spreadsheet("Test List 2")
        
        spreadsheets = database_instance.list_spreadsheets()
        assert isinstance(spreadsheets, list)
        assert len(spreadsheets) >= 2
    
    def test_create_sheet(self, database_instance):
        """Test creating a new sheet"""
        spreadsheet = database_instance.create_spreadsheet("Test Sheets")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        sheet = database_instance.create_sheet(spreadsheet_id, "Sheet2")
        assert sheet["title"] == "Sheet2"
        assert "sheetId" in sheet
    
    def test_list_sheets(self, database_instance):
        """Test listing sheets in a spreadsheet"""
        spreadsheet = database_instance.create_spreadsheet("Test Sheet List")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        database_instance.create_sheet(spreadsheet_id, "Sheet2")
        database_instance.create_sheet(spreadsheet_id, "Sheet3")
        
        sheets = database_instance.list_sheets(spreadsheet_id)
        assert len(sheets) >= 3  # Default Sheet1 + 2 new sheets
        assert "Sheet1" in sheets
        assert "Sheet2" in sheets
        assert "Sheet3" in sheets
    
    def test_update_cells(self, database_instance):
        """Test updating cells"""
        spreadsheet = database_instance.create_spreadsheet("Test Update")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        data = [
            ["Name", "Age", "City"],
            ["Alice", "30", "NYC"],
            ["Bob", "25", "LA"]
        ]
        
        result = database_instance.update_cells(spreadsheet_id, "Sheet1", "A1", data)
        
        assert "error" not in result
        assert result["updatedCells"] == 9
        assert result["updatedRows"] == 3
        assert result["updatedColumns"] == 3
    
    def test_get_values(self, database_instance):
        """Test getting cell values"""
        spreadsheet = database_instance.create_spreadsheet("Test Get Values")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        data = [["A", "B"], ["C", "D"]]
        database_instance.update_cells(spreadsheet_id, "Sheet1", "A1", data)
        
        values = database_instance.get_values(spreadsheet_id, "Sheet1", "A1:B2")
        
        assert len(values) == 2
        assert values[0] == ["A", "B"]
        assert values[1] == ["C", "D"]
    
    def test_get_formulas(self, database_instance):
        """Test getting formulas"""
        spreadsheet = database_instance.create_spreadsheet("Test Formulas")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        data = [["10", "20", "=A1+B1"]]
        database_instance.update_cells(spreadsheet_id, "Sheet1", "A1", data)
        
        formulas = database_instance.get_formulas(spreadsheet_id, "Sheet1", "A1:C1")
        
        assert len(formulas) == 1
        assert formulas[0][2] == "=A1+B1"
    
    def test_batch_update_cells(self, database_instance):
        """Test batch updating cells"""
        spreadsheet = database_instance.create_spreadsheet("Test Batch")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        ranges = {
            "A1:B2": [["1", "2"], ["3", "4"]],
            "D1:E2": [["a", "b"], ["c", "d"]]
        }
        
        result = database_instance.batch_update_cells(spreadsheet_id, "Sheet1", ranges)
        
        assert result["totalUpdatedCells"] == 8
        assert len(result["responses"]) == 2
    
    def test_rename_sheet(self, database_instance):
        """Test renaming a sheet"""
        spreadsheet = database_instance.create_spreadsheet("Test Rename")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        success = database_instance.rename_sheet(spreadsheet_id, "Sheet1", "Renamed")
        
        assert success is True
        sheets = database_instance.list_sheets(spreadsheet_id)
        assert "Renamed" in sheets
        assert "Sheet1" not in sheets
    
    def test_copy_sheet(self, database_instance):
        """Test copying a sheet"""
        spreadsheet1 = database_instance.create_spreadsheet("Source")
        spreadsheet2 = database_instance.create_spreadsheet("Destination")
        
        # Add some data to source
        database_instance.update_cells(
            spreadsheet1["spreadsheetId"], 
            "Sheet1", 
            "A1", 
            [["Data1", "Data2"]]
        )
        
        result = database_instance.copy_sheet(
            spreadsheet1["spreadsheetId"],
            "Sheet1",
            spreadsheet2["spreadsheetId"],
            "Copied"
        )
        
        assert "error" not in result
        assert result["title"] == "Copied"
        
        # Verify data was copied
        values = database_instance.get_values(spreadsheet2["spreadsheetId"], "Copied")
        assert len(values) > 0
    
    def test_add_rows(self, database_instance):
        """Test adding rows"""
        spreadsheet = database_instance.create_spreadsheet("Test Add Rows")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        success = database_instance.add_rows(spreadsheet_id, "Sheet1", 5)
        assert success is True
        
        sheet = database_instance.get_sheet(spreadsheet_id, "Sheet1")
        assert sheet["gridProperties"]["rowCount"] == 1005  # 1000 + 5
    
    def test_add_columns(self, database_instance):
        """Test adding columns"""
        spreadsheet = database_instance.create_spreadsheet("Test Add Cols")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        success = database_instance.add_columns(spreadsheet_id, "Sheet1", 3)
        assert success is True
        
        sheet = database_instance.get_sheet(spreadsheet_id, "Sheet1")
        assert sheet["gridProperties"]["columnCount"] == 29  # 26 + 3
    
    def test_share_spreadsheet(self, database_instance):
        """Test sharing a spreadsheet"""
        spreadsheet = database_instance.create_spreadsheet("Test Share")
        spreadsheet_id = spreadsheet["spreadsheetId"]
        
        recipients = [
            {"email_address": "user1@example.com", "role": "writer"},
            {"email_address": "user2@example.com", "role": "reader"}
        ]
        
        result = database_instance.share_spreadsheet(spreadsheet_id, recipients)
        
        assert len(result["successes"]) == 2
        assert len(result["failures"]) == 0
    
    def test_database_stats(self, database_instance):
        """Test database statistics"""
        stats = database_instance.get_database_stats()
        
        assert "total_spreadsheets" in stats
        assert "total_sheets" in stats
        assert "total_cells" in stats
        assert "files" in stats


class TestGoogleSheetMCPServer(BaseMCPTest):
    """Test the Google Sheets MCP server"""
    
    @pytest.fixture
    def server_instance(self):
        """Return Google Sheets MCP server instance"""
        return GoogleSheetMCPServer()
    
    @pytest.fixture
    def mcp_tester(self, server_instance):
        """Return MCP server tester"""
        return MCPServerTester(server_instance)
    
    @pytest.mark.asyncio
    async def test_tools_exist(self, mcp_tester):
        """Test that expected tools exist"""
        expected_tools = [
            "get_sheet_data",
            "get_sheet_formulas",
            "update_cells",
            "batch_update_cells",
            "add_rows",
            "add_columns",
            "list_sheets",
            "copy_sheet",
            "rename_sheet",
            "get_multiple_sheet_data",
            "get_multiple_spreadsheet_summary",
            "create_spreadsheet",
            "create_sheet",
            "list_spreadsheets",
            "share_spreadsheet"
        ]
        
        results = await mcp_tester.test_all_tools_exist(expected_tools)
        for tool_name, exists in results.items():
            assert exists, f"Tool {tool_name} should exist"
    
    @pytest.mark.asyncio
    async def test_create_spreadsheet_tool(self, mcp_tester):
        """Test the create_spreadsheet tool"""
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "create_spreadsheet",
            {"title": "Test Spreadsheet"}
        )
        assert is_valid
    
    @pytest.mark.asyncio
    async def test_list_spreadsheets_tool(self, mcp_tester):
        """Test the list_spreadsheets tool"""
        is_valid = await mcp_tester.test_tool_with_valid_args(
            "list_spreadsheets",
            {}
        )
        assert is_valid
    
    @pytest.mark.asyncio
    async def test_create_sheet_tool(self, server_instance):
        """Test the create_sheet tool"""
        # Create a spreadsheet first
        result = await server_instance.create_spreadsheet({"title": "Test for Sheets"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Create a sheet
        result = await server_instance.create_sheet({
            "spreadsheet_id": spreadsheet_id,
            "title": "NewSheet"
        })
        
        assert result is not None
        content = json.loads(result[0].text)
        assert content["title"] == "NewSheet"
    
    @pytest.mark.asyncio
    async def test_update_and_get_cells(self, server_instance):
        """Test updating and getting cells"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Update"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Update cells
        data = [["Name", "Value"], ["Item1", "100"]]
        result = await server_instance.update_cells({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "range": "A1",
            "data": data
        })
        
        assert result is not None
        
        # Get cells back
        result = await server_instance.get_sheet_data({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "range": "A1:B2"
        })
        
        content = json.loads(result[0].text)
        assert "valueRanges" in content
        values = content["valueRanges"][0]["values"]
        assert len(values) == 2
        assert values[0] == ["Name", "Value"]
    
    @pytest.mark.asyncio
    async def test_list_sheets_tool(self, server_instance):
        """Test listing sheets"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test List Sheets"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Create additional sheet
        await server_instance.create_sheet({
            "spreadsheet_id": spreadsheet_id,
            "title": "Sheet2"
        })
        
        # List sheets
        result = await server_instance.list_sheets({
            "spreadsheet_id": spreadsheet_id
        })
        
        content = json.loads(result[0].text)
        assert len(content) >= 2
        assert "Sheet1" in content
        assert "Sheet2" in content
    
    @pytest.mark.asyncio
    async def test_rename_sheet_tool(self, server_instance):
        """Test renaming a sheet"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Rename"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Rename sheet
        result = await server_instance.rename_sheet({
            "spreadsheet": spreadsheet_id,
            "sheet": "Sheet1",
            "new_name": "Renamed"
        })
        
        assert result is not None
        
        # Verify rename
        result = await server_instance.list_sheets({
            "spreadsheet_id": spreadsheet_id
        })
        content = json.loads(result[0].text)
        assert "Renamed" in content
    
    @pytest.mark.asyncio
    async def test_add_rows_tool(self, server_instance):
        """Test adding rows"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Add Rows"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Add rows
        result = await server_instance.add_rows({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "count": 5
        })
        
        assert result is not None
        content = json.loads(result[0].text)
        assert "replies" in content
    
    @pytest.mark.asyncio
    async def test_add_columns_tool(self, server_instance):
        """Test adding columns"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Add Columns"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Add columns
        result = await server_instance.add_columns({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "count": 3
        })
        
        assert result is not None
        content = json.loads(result[0].text)
        assert "replies" in content
    
    @pytest.mark.asyncio
    async def test_batch_update_cells_tool(self, server_instance):
        """Test batch updating cells"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Batch"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Batch update
        result = await server_instance.batch_update_cells({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "ranges": {
                "A1:B2": [["1", "2"], ["3", "4"]],
                "D1": [["Test"]]
            }
        })
        
        assert result is not None
        content = json.loads(result[0].text)
        assert content["totalUpdatedCells"] > 0
    
    @pytest.mark.asyncio
    async def test_get_sheet_formulas_tool(self, server_instance):
        """Test getting sheet formulas"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Formulas"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Add formula
        await server_instance.update_cells({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "range": "A1",
            "data": [["10", "20", "=A1+B1"]]
        })
        
        # Get formulas
        result = await server_instance.get_sheet_formulas({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "range": "A1:C1"
        })
        
        content = json.loads(result[0].text)
        assert len(content) > 0
    
    @pytest.mark.asyncio
    async def test_get_multiple_sheet_data_tool(self, server_instance):
        """Test getting data from multiple sheets"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Multiple"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Add data
        await server_instance.update_cells({
            "spreadsheet_id": spreadsheet_id,
            "sheet": "Sheet1",
            "range": "A1",
            "data": [["Data1"]]
        })
        
        # Get multiple
        result = await server_instance.get_multiple_sheet_data({
            "queries": [
                {
                    "spreadsheet_id": spreadsheet_id,
                    "sheet": "Sheet1",
                    "range": "A1"
                }
            ]
        })
        
        content = json.loads(result[0].text)
        assert len(content) == 1
        assert "data" in content[0]
    
    @pytest.mark.asyncio
    async def test_get_multiple_spreadsheet_summary_tool(self, server_instance):
        """Test getting summary of multiple spreadsheets"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Summary"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Get summary
        result = await server_instance.get_multiple_spreadsheet_summary({
            "spreadsheet_ids": [spreadsheet_id],
            "rows_to_fetch": 5
        })
        
        content = json.loads(result[0].text)
        assert len(content) == 1
        assert content[0]["spreadsheet_id"] == spreadsheet_id
        assert "sheets" in content[0]
    
    @pytest.mark.asyncio
    async def test_share_spreadsheet_tool(self, server_instance):
        """Test sharing a spreadsheet"""
        # Create spreadsheet
        result = await server_instance.create_spreadsheet({"title": "Test Share"})
        content = json.loads(result[0].text)
        spreadsheet_id = content["spreadsheetId"]
        
        # Share
        result = await server_instance.share_spreadsheet({
            "spreadsheet_id": spreadsheet_id,
            "recipients": [
                {"email_address": "test@example.com", "role": "reader"}
            ],
            "send_notification": False
        })
        
        content = json.loads(result[0].text)
        assert "successes" in content
        assert len(content["successes"]) == 1


if __name__ == "__main__":
    # Run the tests
    pytest.main([__file__, "-v"])
