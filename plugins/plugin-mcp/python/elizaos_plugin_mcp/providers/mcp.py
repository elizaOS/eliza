"""MCP provider for connected servers, tools, and resources."""

import json
from dataclasses import dataclass


@dataclass
class ProviderContext:
    state: dict[str, object]


@dataclass
class ProviderResult:
    values: dict[str, object]
    data: dict[str, object]
    text: str


class McpProvider:
    name = "MCP"
    description = "Information about connected MCP servers, tools, and resources"

    def format_servers(self, servers: list[object]) -> str:
        if not servers:
            return "No MCP servers are available."

        output = "# Connected MCP Servers\n\n"

        for server_obj in servers:
            if not isinstance(server_obj, dict):
                continue

            server = server_obj
            name_obj = server.get("name", "")
            status_obj = server.get("status", "")

            name = name_obj if isinstance(name_obj, str) else str(name_obj)
            status = status_obj if isinstance(status_obj, str) else str(status_obj)

            output += f"## {name} ({status})\n"

            tools_obj = server.get("tools", [])
            if isinstance(tools_obj, list) and tools_obj:
                output += "\n**Tools:**\n"
                for tool_obj in tools_obj:
                    if not isinstance(tool_obj, dict):
                        continue
                    tool_name_obj = tool_obj.get("name", "")
                    description_obj = tool_obj.get("description", "")
                    tool_name = (
                        tool_name_obj if isinstance(tool_name_obj, str) else str(tool_name_obj)
                    )
                    description = (
                        description_obj
                        if isinstance(description_obj, str)
                        else str(description_obj)
                    )
                    output += f"- {tool_name}: {description}\n"

            resources_obj = server.get("resources", [])
            if isinstance(resources_obj, list) and resources_obj:
                output += "\n**Resources:**\n"
                for resource_obj in resources_obj:
                    if not isinstance(resource_obj, dict):
                        continue
                    uri_obj = resource_obj.get("uri", "")
                    res_name_obj = resource_obj.get("name", "")
                    uri = uri_obj if isinstance(uri_obj, str) else str(uri_obj)
                    res_name = res_name_obj if isinstance(res_name_obj, str) else str(res_name_obj)
                    output += f"- {uri}: {res_name}\n"

            output += "\n"

        return output

    async def get(self, context: ProviderContext) -> ProviderResult:
        servers_obj = context.state.get("mcpServers", [])
        servers: list[object] = servers_obj if isinstance(servers_obj, list) else []
        text = self.format_servers(servers)
        server_count = len(servers)

        return ProviderResult(
            values={"mcpServers": json.dumps(servers)},
            data={"mcpServerCount": server_count},
            text=text,
        )


mcp_provider = McpProvider()
