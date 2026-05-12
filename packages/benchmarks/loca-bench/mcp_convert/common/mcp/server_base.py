"""
Base MCP server implementation

Provides common functionality for all MCP server implementations.
"""

import asyncio
import logging
import os
from typing import Any, Dict, List

# Suppress logging unless verbose mode is enabled (must be before mcp imports)
if os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes'):
    logging.basicConfig(level=logging.WARNING, force=True)
    logging.getLogger().setLevel(logging.WARNING)
    for _logger_name in ["mcp", "fastmcp", "mcp.server", "mcp.client", "httpx", "asyncio"]:
        logging.getLogger(_logger_name).setLevel(logging.WARNING)

from mcp.server import Server
from mcp.server.models import InitializationOptions
from mcp.server import NotificationOptions
import mcp.server.stdio
import mcp.types as types


class BaseMCPServer:
    """Base class for MCP server implementations"""
    
    def __init__(self, server_name: str, server_version: str = "1.0.0"):
        """Initialize base MCP server"""
        self.server_name = server_name
        self.server_version = server_version
        self.server = Server(server_name)
        self.tools = {}
        self.setup_handlers()
    
    def setup_handlers(self):
        """Setup MCP server handlers"""
        @self.server.list_tools()
        async def handle_list_tools() -> List[types.Tool]:
            return await self.list_tools()
        
        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
            return await self.call_tool(name, arguments)
    
    async def list_tools(self) -> List[types.Tool]:
        """List available tools - to be implemented by subclasses"""
        return list(self.tools.values())
    
    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
        """Handle tool calls - to be implemented by subclasses"""
        if name not in self.tools:
            return [types.TextContent(
                type="text",
                text=f"Unknown tool: {name}"
            )]
        
        # This should be overridden by subclasses to implement actual tool logic
        return [types.TextContent(
            type="text",
            text=f"Tool {name} called with arguments: {arguments}"
        )]
    
    def register_tool(self, tool: types.Tool):
        """Register a tool with the server"""
        self.tools[tool.name] = tool
    
    def create_text_response(self, text: str) -> List[types.TextContent]:
        """Create a standard text response"""
        return [types.TextContent(type="text", text=text)]
    
    def create_json_response(self, data: Any) -> List[types.TextContent]:
        """Create a JSON response"""
        import json
        return [types.TextContent(
            type="text", 
            text=json.dumps(data, indent=2, ensure_ascii=False)
        )]
    
    def create_error_response(self, error_message: str) -> List[types.TextContent]:
        """Create an error response"""
        return [types.TextContent(
            type="text",
            text=f"Error: {error_message}"
        )]
    
    async def run(self):
        """Run the MCP server"""
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            await self.server.run(
                read_stream,
                write_stream,
                InitializationOptions(
                    server_name=self.server_name,
                    server_version=self.server_version,
                    capabilities=self.server.get_capabilities(
                        notification_options=NotificationOptions(),
                        experimental_capabilities={}
                    )
                )
            )