"""Excel MCP Server - Excel File Manipulation System.

This module provides access to the excel-mcp-server MCP server,
which implements comprehensive Excel file manipulation capabilities
including reading, writing, formatting, and data analysis operations.

The Excel server communicates through stdio transport.

Package: https://github.com/haris-musa/excel-mcp-server
Documentation: https://github.com/haris-musa/excel-mcp-server/blob/main/TOOLS.md
"""

from .helper import create_excel_tool, create_excel_tool_from_config

__all__ = ["create_excel_tool", "create_excel_tool_from_config"]

