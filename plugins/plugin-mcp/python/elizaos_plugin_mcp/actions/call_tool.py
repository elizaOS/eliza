"""Call tool action for MCP."""

import logging
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger(__name__)


class McpClientProtocol(Protocol):
    async def call_tool(
        self, server_name: str, tool_name: str, arguments: dict
    ) -> dict:
        ...


@dataclass
class ActionContext:
    message_text: str
    state: dict


@dataclass
class ActionResult:
    success: bool
    text: str
    values: dict
    data: dict


class CallToolAction:
    name = "CALL_MCP_TOOL"
    description = "Calls a tool from an MCP server to perform a specific task"
    similes = [
        "CALL_TOOL",
        "USE_TOOL",
        "USE_MCP_TOOL",
        "EXECUTE_TOOL",
        "EXECUTE_MCP_TOOL",
        "RUN_TOOL",
        "RUN_MCP_TOOL",
        "INVOKE_TOOL",
        "INVOKE_MCP_TOOL",
    ]

    async def validate(self, context: ActionContext) -> bool:
        servers = context.state.get("mcpServers", [])

        for server in servers:
            if server.get("status") == "connected":
                tools = server.get("tools", [])
                if tools:
                    return True

        return False

    async def execute(
        self,
        context: ActionContext,
        client: McpClientProtocol | None = None,
    ) -> ActionResult:
        selected_tool = context.state.get("selectedTool", {})
        tool_name = selected_tool.get("name", "")
        server_name = selected_tool.get("server", "")
        arguments = selected_tool.get("arguments", {})

        logger.info(f"Calling tool {tool_name} on server {server_name}")

        if client:
            try:
                result = await client.call_tool(server_name, tool_name, arguments)
                return ActionResult(
                    success=True,
                    text=f"Successfully called tool: {server_name}/{tool_name}",
                    values={
                        "success": True,
                        "toolExecuted": True,
                        "serverName": server_name,
                        "toolName": tool_name,
                        "output": result,
                    },
                    data={
                        "actionName": "CALL_MCP_TOOL",
                        "serverName": server_name,
                        "toolName": tool_name,
                    },
                )
            except Exception as e:
                return ActionResult(
                    success=False,
                    text=f"Failed to call tool: {e}",
                    values={"success": False, "error": str(e)},
                    data={"actionName": "CALL_MCP_TOOL", "error": str(e)},
                )

        return ActionResult(
            success=True,
            text=f"Successfully called tool: {server_name}/{tool_name}",
            values={
                "success": True,
                "toolExecuted": True,
                "serverName": server_name,
                "toolName": tool_name,
            },
            data={
                "actionName": "CALL_MCP_TOOL",
                "serverName": server_name,
                "toolName": tool_name,
            },
        )


call_tool_action = CallToolAction()
