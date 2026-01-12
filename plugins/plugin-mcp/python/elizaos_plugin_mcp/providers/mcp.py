"""MCP provider for connected servers, tools, and resources."""

import json
from dataclasses import dataclass


@dataclass
class ProviderContext:
    state: dict


@dataclass
class ProviderResult:
    values: dict
    data: dict
    text: str


class McpProvider:
    name = "MCP"
    description = "Information about connected MCP servers, tools, and resources"

    def format_servers(self, servers: list) -> str:
        if not servers:
            return "No MCP servers are available."

        output = "# Connected MCP Servers\n\n"

        for server in servers:
            name = server.get("name", "")
            status = server.get("status", "")

            output += f"## {name} ({status})\n"

            tools = server.get("tools", [])
            if tools:
                output += "\n**Tools:**\n"
                for tool in tools:
                    tool_name = tool.get("name", "")
                    description = tool.get("description", "")
                    output += f"- {tool_name}: {description}\n"

            resources = server.get("resources", [])
            if resources:
                output += "\n**Resources:**\n"
                for resource in resources:
                    uri = resource.get("uri", "")
                    res_name = resource.get("name", "")
                    output += f"- {uri}: {res_name}\n"

            output += "\n"

        return output

    async def get(self, context: ProviderContext) -> ProviderResult:
        servers = context.state.get("mcpServers", [])
        text = self.format_servers(servers)
        server_count = len(servers)

        return ProviderResult(
            values={"mcpServers": json.dumps(servers)},
            data={"mcpServerCount": server_count},
            text=text,
        )


mcp_provider = McpProvider()
