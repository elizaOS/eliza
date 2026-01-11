"""Tests for type definitions."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from elizaos_plugin_mcp.types import (
    HttpServerConfig,
    McpError,
    McpResource,
    McpResourceTemplate,
    McpTool,
    StdioServerConfig,
)


class TestStdioServerConfig:
    """Tests for StdioServerConfig."""

    def test_valid_config(self) -> None:
        """Test creating a valid config."""
        config = StdioServerConfig(
            command="npx",
            args=["-y", "some-package"],
            env={"NODE_ENV": "production"},
            cwd="/home/user",
            timeout_ms=5000,
        )
        assert config.type == "stdio"
        assert config.command == "npx"
        assert config.args == ["-y", "some-package"]
        assert config.env == {"NODE_ENV": "production"}
        assert config.cwd == "/home/user"
        assert config.timeout_ms == 5000

    def test_minimal_config(self) -> None:
        """Test creating a minimal config."""
        config = StdioServerConfig(command="python")
        assert config.command == "python"
        assert config.args == []
        assert config.env == {}
        assert config.cwd is None
        assert config.timeout_ms == 60000

    def test_empty_command_fails(self) -> None:
        """Test that empty command fails validation."""
        with pytest.raises(ValidationError):
            StdioServerConfig(command="")

    def test_invalid_timeout_fails(self) -> None:
        """Test that invalid timeout fails validation."""
        with pytest.raises(ValidationError):
            StdioServerConfig(command="python", timeout_ms=0)


class TestHttpServerConfig:
    """Tests for HttpServerConfig."""

    def test_valid_config(self) -> None:
        """Test creating a valid config."""
        config = HttpServerConfig(
            type="http",
            url="https://example.com/mcp",
            timeout_ms=5000,
        )
        assert config.type == "http"
        assert config.url == "https://example.com/mcp"
        assert config.timeout_ms == 5000

    def test_sse_type(self) -> None:
        """Test SSE transport type."""
        config = HttpServerConfig(type="sse", url="https://example.com/sse")
        assert config.type == "sse"

    def test_empty_url_fails(self) -> None:
        """Test that empty URL fails validation."""
        with pytest.raises(ValidationError):
            HttpServerConfig(url="")


class TestMcpTool:
    """Tests for McpTool."""

    def test_valid_tool(self) -> None:
        """Test creating a valid tool."""
        tool = McpTool(
            name="store_memory",
            description="Store a key-value pair in memory",
            inputSchema={
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["key", "value"],
            },
        )
        assert tool.name == "store_memory"
        assert tool.description == "Store a key-value pair in memory"
        assert tool.input_schema.required == ["key", "value"]

    def test_minimal_tool(self) -> None:
        """Test creating a minimal tool."""
        tool = McpTool(name="simple_tool")
        assert tool.name == "simple_tool"
        assert tool.description == ""

    def test_empty_name_fails(self) -> None:
        """Test that empty name fails validation."""
        with pytest.raises(ValidationError):
            McpTool(name="")


class TestMcpResource:
    """Tests for McpResource."""

    def test_valid_resource(self) -> None:
        """Test creating a valid resource."""
        resource = McpResource(
            uri="docs://readme",
            name="README",
            description="Project README file",
            mimeType="text/markdown",
        )
        assert resource.uri == "docs://readme"
        assert resource.name == "README"
        assert resource.description == "Project README file"
        assert resource.mime_type == "text/markdown"

    def test_empty_uri_fails(self) -> None:
        """Test that empty URI fails validation."""
        with pytest.raises(ValidationError):
            McpResource(uri="", name="test")


class TestMcpResourceTemplate:
    """Tests for McpResourceTemplate."""

    def test_valid_template(self) -> None:
        """Test creating a valid resource template."""
        template = McpResourceTemplate(
            uriTemplate="docs://{path}",
            name="Documentation",
            description="Access documentation files",
            mimeType="text/markdown",
        )
        assert template.uri_template == "docs://{path}"
        assert template.name == "Documentation"
        assert template.description == "Access documentation files"
        assert template.mime_type == "text/markdown"

    def test_minimal_template(self) -> None:
        """Test creating a minimal resource template."""
        template = McpResourceTemplate(uriTemplate="files://{path}", name="Files")
        assert template.uri_template == "files://{path}"
        assert template.name == "Files"
        assert template.description == ""
        assert template.mime_type is None

    def test_empty_uri_template_fails(self) -> None:
        """Test that empty URI template fails validation."""
        with pytest.raises(ValidationError):
            McpResourceTemplate(uriTemplate="", name="test")

    def test_empty_name_fails(self) -> None:
        """Test that empty name fails validation."""
        with pytest.raises(ValidationError):
            McpResourceTemplate(uriTemplate="test://{path}", name="")


class TestMcpError:
    """Tests for McpError."""

    def test_basic_error(self) -> None:
        """Test creating a basic error."""
        error = McpError("Something went wrong", "TEST_ERROR")
        assert str(error) == "Something went wrong"
        assert error.code == "TEST_ERROR"
        assert error.message == "Something went wrong"

    def test_connection_error(self) -> None:
        """Test creating a connection error."""
        error = McpError.connection_error("test-server", "timeout")
        assert "test-server" in str(error)
        assert "timeout" in str(error)
        assert error.code == "CONNECTION_ERROR"

    def test_tool_not_found(self) -> None:
        """Test creating a tool not found error."""
        error = McpError.tool_not_found("missing_tool", "server1")
        assert "missing_tool" in str(error)
        assert "server1" in str(error)
        assert error.code == "TOOL_NOT_FOUND"

    def test_validation_error(self) -> None:
        """Test creating a validation error."""
        error = McpError.validation_error("Invalid input")
        assert "Invalid input" in str(error)
        assert error.code == "VALIDATION_ERROR"
