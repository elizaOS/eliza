"""Read resource action for MCP."""

import logging
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger(__name__)


class McpClientProtocol(Protocol):
    async def read_resource(self, server_name: str, uri: str) -> dict:
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


class ReadResourceAction:
    name = "READ_MCP_RESOURCE"
    description = "Reads a resource from an MCP server"
    similes = [
        "READ_RESOURCE",
        "GET_RESOURCE",
        "GET_MCP_RESOURCE",
        "FETCH_RESOURCE",
        "FETCH_MCP_RESOURCE",
        "ACCESS_RESOURCE",
        "ACCESS_MCP_RESOURCE",
    ]

    async def validate(self, context: ActionContext) -> bool:
        servers = context.state.get("mcpServers", [])

        for server in servers:
            if server.get("status") == "connected":
                resources = server.get("resources", [])
                if resources:
                    return True

        return False

    async def execute(
        self,
        context: ActionContext,
        client: McpClientProtocol | None = None,
    ) -> ActionResult:
        selected_resource = context.state.get("selectedResource", {})
        uri = selected_resource.get("uri", "")
        server_name = selected_resource.get("server", "")

        logger.info(f"Reading resource {uri} from server {server_name}")

        if client:
            try:
                result = await client.read_resource(server_name, uri)
                return ActionResult(
                    success=True,
                    text=f"Successfully read resource: {uri}",
                    values={
                        "success": True,
                        "resourceRead": True,
                        "serverName": server_name,
                        "uri": uri,
                        "content": result,
                    },
                    data={
                        "actionName": "READ_MCP_RESOURCE",
                        "serverName": server_name,
                        "uri": uri,
                    },
                )
            except Exception as e:
                return ActionResult(
                    success=False,
                    text=f"Failed to read resource: {e}",
                    values={"success": False, "error": str(e)},
                    data={"actionName": "READ_MCP_RESOURCE", "error": str(e)},
                )

        return ActionResult(
            success=True,
            text=f"Successfully read resource: {uri}",
            values={
                "success": True,
                "resourceRead": True,
                "serverName": server_name,
                "uri": uri,
            },
            data={
                "actionName": "READ_MCP_RESOURCE",
                "serverName": server_name,
                "uri": uri,
            },
        )


read_resource_action = ReadResourceAction()
