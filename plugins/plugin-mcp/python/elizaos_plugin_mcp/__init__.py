"""elizaOS MCP Plugin - Model Context Protocol client for elizaOS agents."""

from elizaos_plugin_mcp.client import McpClient
from elizaos_plugin_mcp.transports import HttpTransport, StdioTransport, Transport
from elizaos_plugin_mcp.types import (
    ConnectionStatus,
    HttpServerConfig,
    McpError,
    McpResource,
    McpResourceContent,
    McpResourceTemplate,
    McpServerConfig,
    McpTool,
    McpToolResult,
    StdioServerConfig,
)

__version__ = "1.7.0"

__all__ = [
    # Client
    "McpClient",
    # Types
    "McpServerConfig",
    "StdioServerConfig",
    "HttpServerConfig",
    "McpTool",
    "McpResource",
    "McpResourceContent",
    "McpResourceTemplate",
    "McpToolResult",
    "McpError",
    "ConnectionStatus",
    # Transports
    "Transport",
    "StdioTransport",
    "HttpTransport",
]
