"""Tool specifications and endpoint mappings."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ToolSpec(BaseModel):
    """Tool definition with JSON Schema input_schema, passable directly to model API."""

    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)


class ToolEndpoint(BaseModel):
    """Maps a tool name to a mock service URL. The model never sees this."""

    tool_name: str
    url: str
    method: str = "POST"
