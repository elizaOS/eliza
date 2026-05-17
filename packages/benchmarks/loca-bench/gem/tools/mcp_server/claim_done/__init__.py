"""ClaimDone MCP Server

A simple MCP server that provides a claim_done tool for agents to signal task completion.
"""

from .helper import create_claim_done_tool_http, create_claim_done_tool_stdio

__all__ = [
    "create_claim_done_tool_stdio",
    "create_claim_done_tool_http",
]


