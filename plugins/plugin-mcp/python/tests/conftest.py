"""Pytest configuration and fixtures."""

from __future__ import annotations

import shutil
from collections.abc import AsyncGenerator

import pytest

from elizaos_plugin_mcp import McpClient, StdioTransport
from elizaos_plugin_mcp.types import StdioServerConfig


@pytest.fixture
def npx_available() -> bool:
    """Check if npx is available."""
    return shutil.which("npx") is not None


@pytest.fixture
def memory_server_config() -> StdioServerConfig:
    """Create a configuration for the memory MCP server."""
    return StdioServerConfig(
        type="stdio",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-memory"],
        # 120 seconds to allow for package download on first run
        timeout_ms=120000,
    )


@pytest.fixture
async def memory_server_client(
    npx_available: bool,
    memory_server_config: StdioServerConfig,
) -> AsyncGenerator[McpClient, None]:
    """Create a connected MCP client for the memory server."""
    if not npx_available:
        pytest.skip("npx not available")

    transport = StdioTransport(memory_server_config)
    client = McpClient(transport)

    await client.connect()
    yield client
    await client.close()
