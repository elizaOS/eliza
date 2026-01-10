"""
elizaOS MCP Agent Server - Python

Exposes an elizaOS agent as an MCP server. Any MCP-compatible client
(Claude Desktop, VS Code, etc.) can interact with your agent.

Uses real elizaOS runtime with OpenAI plugin.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

# ============================================================================
# Configuration
# ============================================================================

logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger(__name__)

CHARACTER = Character(
    name="Eliza",
    username="eliza",
    bio="A helpful AI assistant powered by elizaOS, accessible via MCP.",
    system="You are a helpful, friendly AI assistant. Be concise and informative.",
)

# ============================================================================
# Agent Runtime
# ============================================================================

_runtime: AgentRuntime | None = None
_room_id = uuid7()


async def get_runtime() -> AgentRuntime:
    """Get or initialize the agent runtime."""
    global _runtime

    if _runtime is not None:
        return _runtime

    logger.info("🚀 Initializing elizaOS runtime...")

    _runtime = AgentRuntime(
        character=CHARACTER,
        plugins=[get_openai_plugin()],
        log_level="INFO",
    )

    await _runtime.initialize()
    logger.info("✅ elizaOS runtime initialized")

    return _runtime


async def handle_chat(message: str, user_id: str | None = None) -> str:
    """Send a message to the agent and get a response."""
    runtime = await get_runtime()

    entity_id = uuid7()

    # Create message memory
    msg = Memory(
        entity_id=entity_id,
        room_id=_room_id,
        content=Content(
            text=message,
            source="mcp",
            channel_type=ChannelType.DM.value,
        ),
    )

    # Process message
    result = await runtime.message_service.handle_message(runtime, msg)

    if result and result.response_content and result.response_content.text:
        return result.response_content.text

    return "I didn't generate a response. Please try again."


def get_agent_info() -> dict[str, Any]:
    """Get information about the agent."""
    return {
        "name": CHARACTER.name,
        "bio": CHARACTER.bio or "An AI assistant",
        "capabilities": [
            "Natural language conversation",
            "Helpful responses",
            "Context-aware dialogue",
        ],
    }


# ============================================================================
# MCP Server
# ============================================================================

# Define available tools
TOOLS = [
    Tool(
        name="chat",
        description="Send a message to the Eliza agent and receive a response",
        inputSchema={
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "The message to send to the agent",
                },
                "userId": {
                    "type": "string",
                    "description": "Optional user identifier for conversation context",
                },
            },
            "required": ["message"],
        },
    ),
    Tool(
        name="get_agent_info",
        description="Get information about the Eliza agent",
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
]


async def main() -> None:
    """Run the MCP server."""
    server = Server("eliza-mcp-server")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return TOOLS

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
        try:
            if name == "chat":
                message = arguments.get("message")
                user_id = arguments.get("userId")

                if not message or not isinstance(message, str):
                    return [TextContent(type="text", text="Error: message is required")]

                response = await handle_chat(message, user_id)
                return [TextContent(type="text", text=response)]

            elif name == "get_agent_info":
                info = get_agent_info()
                return [TextContent(type="text", text=json.dumps(info, indent=2))]

            else:
                return [TextContent(type="text", text=f"Unknown tool: {name}")]

        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

    logger.info("🌐 elizaOS MCP Server starting on stdio")
    logger.info("📚 Available tools: chat, get_agent_info")

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())

