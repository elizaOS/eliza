"""PDF Tools MCP Server - PDF File Manipulation System.

This module provides access to the pdf-tools-mcp MCP server,
which implements comprehensive PDF file manipulation capabilities
including reading, extracting text, merging, splitting, and other PDF operations.

The PDF Tools server communicates through stdio transport.

Package: https://github.com/lockon-n/pdf-tools-mcp
"""

from .helper import (
    create_pdf_tools_tool,
    create_pdf_tools_tool_from_config,
    get_pdf_tools_stdio_config,
)

__all__ = [
    "create_pdf_tools_tool",
    "create_pdf_tools_tool_from_config",
    "get_pdf_tools_stdio_config",
]















