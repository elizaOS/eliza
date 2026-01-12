"""Type definitions for the MCP plugin."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class ConnectionStatus(str, Enum):
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    FAILED = "failed"


class StdioServerConfig(BaseModel):
    type: Literal["stdio"] = "stdio"
    command: str = Field(..., min_length=1, description="Command to execute")
    args: list[str] = Field(default_factory=list, description="Command arguments")
    env: dict[str, str] = Field(default_factory=dict, description="Environment variables")
    cwd: str | None = Field(default=None, description="Working directory")
    timeout_ms: int = Field(default=60000, ge=1, description="Timeout in milliseconds")


class HttpServerConfig(BaseModel):
    type: Literal["http", "streamable-http", "sse"] = "http"
    url: str = Field(..., min_length=1, description="Server URL")
    timeout_ms: int = Field(default=30000, ge=1, description="Timeout in milliseconds")


McpServerConfig = StdioServerConfig | HttpServerConfig


class JsonSchemaProperty(BaseModel):
    type: str | None = None
    description: str | None = None
    properties: dict[str, JsonSchemaProperty] | None = None
    required: list[str] | None = None
    items: JsonSchemaProperty | None = None
    enum: list[str] | None = None
    minimum: float | None = None
    maximum: float | None = None
    min_length: int | None = Field(default=None, alias="minLength")
    max_length: int | None = Field(default=None, alias="maxLength")
    pattern: str | None = None
    format: str | None = None

    model_config = {"populate_by_name": True}


class McpToolInputSchema(BaseModel):
    """Input schema for an MCP tool."""

    type: str = "object"
    properties: dict[str, JsonSchemaProperty] = Field(default_factory=dict)
    required: list[str] = Field(default_factory=list)


class McpTool(BaseModel):
    name: str = Field(..., min_length=1)
    description: str = Field(default="")
    input_schema: McpToolInputSchema = Field(
        default_factory=McpToolInputSchema, alias="inputSchema"
    )

    model_config = {"populate_by_name": True}


class McpResource(BaseModel):
    uri: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    description: str = Field(default="")
    mime_type: str | None = Field(default=None, alias="mimeType")

    model_config = {"populate_by_name": True}


class McpResourceTemplate(BaseModel):
    uri_template: str = Field(..., min_length=1, alias="uriTemplate")
    name: str = Field(..., min_length=1)
    description: str = Field(default="")
    mime_type: str | None = Field(default=None, alias="mimeType")

    model_config = {"populate_by_name": True}


class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImageContent(BaseModel):
    type: Literal["image"] = "image"
    data: str  # Base64 encoded
    mime_type: str = Field(alias="mimeType")

    model_config = {"populate_by_name": True}


class McpResourceContent(BaseModel):
    uri: str
    mime_type: str | None = Field(default=None, alias="mimeType")
    text: str | None = None
    blob: str | None = None  # Base64 encoded binary data

    model_config = {"populate_by_name": True}


class EmbeddedResource(BaseModel):
    type: Literal["resource"] = "resource"
    resource: McpResourceContent


McpContent = TextContent | ImageContent | EmbeddedResource


class McpToolResult(BaseModel):
    content: list[McpContent]
    is_error: bool = Field(default=False, alias="isError")

    model_config = {"populate_by_name": True}


class McpError(Exception):
    def __init__(self, message: str, code: str = "UNKNOWN") -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    @classmethod
    def connection_error(cls, server_name: str, details: str | None = None) -> McpError:
        msg = f"Failed to connect to server '{server_name}'"
        if details:
            msg += f": {details}"
        return cls(msg, "CONNECTION_ERROR")

    @classmethod
    def tool_not_found(cls, tool_name: str, server_name: str) -> McpError:
        return cls(f"Tool '{tool_name}' not found on server '{server_name}'", "TOOL_NOT_FOUND")

    @classmethod
    def resource_not_found(cls, uri: str, server_name: str) -> McpError:
        return cls(f"Resource '{uri}' not found on server '{server_name}'", "RESOURCE_NOT_FOUND")

    @classmethod
    def validation_error(cls, details: str) -> McpError:
        return cls(f"Validation error: {details}", "VALIDATION_ERROR")

    @classmethod
    def timeout_error(cls, operation: str) -> McpError:
        return cls(f"Operation timed out: {operation}", "TIMEOUT_ERROR")
