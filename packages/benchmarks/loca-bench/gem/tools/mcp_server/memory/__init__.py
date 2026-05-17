"""Memory MCP Server - Knowledge Graph Memory System.

This module provides access to the @modelcontextprotocol/server-memory MCP server,
which implements a knowledge graph-based memory system for storing and retrieving
information across conversations.

The memory server is run via npx and communicates through stdio transport.
"""

from .helper import create_memory_tool, create_memory_tool_from_config

__all__ = ["create_memory_tool", "create_memory_tool_from_config"]
