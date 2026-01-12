"""Tests for MCP actions."""

import pytest

from elizaos_plugin_mcp.actions.call_tool import (
    ActionContext,
    CallToolAction,
)
from elizaos_plugin_mcp.actions.read_resource import (
    ReadResourceAction,
)


class TestCallToolAction:
    """Tests for CallToolAction."""

    @pytest.fixture
    def action(self) -> CallToolAction:
        """Create action instance."""
        return CallToolAction()

    @pytest.mark.asyncio
    async def test_name(self, action: CallToolAction) -> None:
        """Test action name."""
        assert action.name == "CALL_MCP_TOOL"

    @pytest.mark.asyncio
    async def test_description(self, action: CallToolAction) -> None:
        """Test action description."""
        assert "MCP" in action.description

    @pytest.mark.asyncio
    async def test_validate_no_servers(self, action: CallToolAction) -> None:
        """Test validation with no servers."""
        context = ActionContext(
            message_text="call a tool",
            state={},
        )
        result = await action.validate(context)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_with_tools(self, action: CallToolAction) -> None:
        """Test validation with connected server and tools."""
        context = ActionContext(
            message_text="call a tool",
            state={
                "mcpServers": [
                    {
                        "name": "test-server",
                        "status": "connected",
                        "tools": [{"name": "search"}],
                    }
                ]
            },
        )
        result = await action.validate(context)
        assert result is True

    @pytest.mark.asyncio
    async def test_execute(self, action: CallToolAction) -> None:
        """Test execute without client."""
        context = ActionContext(
            message_text="call a tool",
            state={
                "selectedTool": {
                    "name": "search",
                    "server": "test-server",
                }
            },
        )
        result = await action.execute(context)
        assert result.success is True
        assert "test-server/search" in result.text


class TestReadResourceAction:
    """Tests for ReadResourceAction."""

    @pytest.fixture
    def action(self) -> ReadResourceAction:
        """Create action instance."""
        return ReadResourceAction()

    @pytest.mark.asyncio
    async def test_name(self, action: ReadResourceAction) -> None:
        """Test action name."""
        assert action.name == "READ_MCP_RESOURCE"

    @pytest.mark.asyncio
    async def test_validate_no_resources(self, action: ReadResourceAction) -> None:
        """Test validation with no resources."""
        context = ActionContext(
            message_text="read a resource",
            state={},
        )
        result = await action.validate(context)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_with_resources(self, action: ReadResourceAction) -> None:
        """Test validation with connected server and resources."""
        context = ActionContext(
            message_text="read a resource",
            state={
                "mcpServers": [
                    {
                        "name": "test-server",
                        "status": "connected",
                        "resources": [{"uri": "file:///test.txt"}],
                    }
                ]
            },
        )
        result = await action.validate(context)
        assert result is True
