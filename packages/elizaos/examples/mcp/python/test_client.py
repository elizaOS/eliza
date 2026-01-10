"""
Test client for elizaOS MCP Server

Connects to the MCP server and tests the chat and get_agent_info tools.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import stdio_client, StdioServerParameters


async def main() -> None:
    print("🧪 Testing elizaOS MCP Server\n")

    server_params = StdioServerParameters(
        command=sys.executable,
        args=["server.py"],
        cwd=str(Path(__file__).parent),
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            # Initialize
            await session.initialize()
            print("✅ Connected to MCP server\n")

            # Test 1: List tools
            print("📋 Listing available tools...")
            tools_result = await session.list_tools()
            print(f"   Found {len(tools_result.tools)} tools:")
            for tool in tools_result.tools:
                print(f"   - {tool.name}: {tool.description}")
            print()

            # Test 2: Get agent info
            print("ℹ️  Getting agent info...")
            info_result = await session.call_tool("get_agent_info", {})
            if info_result.content and info_result.content[0].type == "text":
                info = json.loads(info_result.content[0].text)
                print(f"   Name: {info['name']}")
                print(f"   Bio: {info['bio']}")
                print(f"   Capabilities: {', '.join(info['capabilities'])}")
            print()

            # Test 3: Chat with agent
            print("💬 Testing chat...")
            test_messages = [
                "Hello! What's your name?",
                "What can you help me with?",
            ]

            for message in test_messages:
                print(f"   User: {message}")
                chat_result = await session.call_tool("chat", {"message": message})
                if chat_result.content and chat_result.content[0].type == "text":
                    print(f"   Agent: {chat_result.content[0].text}")
                print()

            print("✅ All tests passed!")


if __name__ == "__main__":
    asyncio.run(main())

