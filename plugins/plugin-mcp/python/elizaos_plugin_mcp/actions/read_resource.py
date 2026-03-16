"""Read resource action for MCP."""

import logging
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger(__name__)


class McpClientProtocol(Protocol):
    async def read_resource(self, server_name: str, uri: str) -> dict[str, object]: ...


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
        servers_obj = context.state.get("mcpServers", [])
        servers: list[object] = servers_obj if isinstance(servers_obj, list) else []

        for server_obj in servers:
            if not isinstance(server_obj, dict):
                continue

            if server_obj.get("status") == "connected":
                resources_obj = server_obj.get("resources", [])
                if isinstance(resources_obj, list) and resources_obj:
                    return True

        return False

    async def execute(
        self,
        context: ActionContext,
        client: McpClientProtocol | None = None,
    ) -> ActionResult:
        selected_resource_obj = context.state.get("selectedResource", {})
        selected_resource: dict[str, object] = (
            selected_resource_obj if isinstance(selected_resource_obj, dict) else {}
        )

        uri_obj = selected_resource.get("uri", "")
        server_name_obj = selected_resource.get("server", "")
        uri = uri_obj if isinstance(uri_obj, str) else str(uri_obj)
        server_name = server_name_obj if isinstance(server_name_obj, str) else str(server_name_obj)

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
