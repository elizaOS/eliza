"""Call tool action for MCP."""

import logging
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger(__name__)


class McpClientProtocol(Protocol):
    async def call_tool(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict[str, object],
    ) -> dict[str, object]: ...


@dataclass
class ActionContext:
    message_text: str
    state: dict[str, object]


@dataclass
class ActionResult:
    success: bool
    text: str
    values: dict[str, object]
    data: dict[str, object]


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
        servers_obj = context.state.get("mcpServers", [])
        servers: list[object] = servers_obj if isinstance(servers_obj, list) else []

        for server_obj in servers:
            if not isinstance(server_obj, dict):
                continue

            if server_obj.get("status") == "connected":
                tools_obj = server_obj.get("tools", [])
                if isinstance(tools_obj, list) and tools_obj:
                    return True

        return False

    async def execute(
        self,
        context: ActionContext,
        client: McpClientProtocol | None = None,
    ) -> ActionResult:
        selected_tool_obj = context.state.get("selectedTool", {})
        selected_tool: dict[str, object] = (
            selected_tool_obj if isinstance(selected_tool_obj, dict) else {}
        )

        tool_name_obj = selected_tool.get("name", "")
        server_name_obj = selected_tool.get("server", "")
        arguments_obj = selected_tool.get("arguments", {})

        tool_name = tool_name_obj if isinstance(tool_name_obj, str) else str(tool_name_obj)
        server_name = server_name_obj if isinstance(server_name_obj, str) else str(server_name_obj)
        arguments: dict[str, object] = arguments_obj if isinstance(arguments_obj, dict) else {}

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
