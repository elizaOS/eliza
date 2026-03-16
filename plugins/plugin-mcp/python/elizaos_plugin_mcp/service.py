from __future__ import annotations

from elizaos_plugin_mcp.client import McpClient


class McpService:
    """
    Minimal service wrapper for MCP server connections (TS parity: `McpService`).
    """

    service_type: str = "mcp"
    capability_description: str = (
        "Enables the agent to interact with MCP (Model Context Protocol) servers"
    )

    def __init__(self) -> None:
        self._clients: dict[str, McpClient] = {}

    def insert_client(self, name: str, client: McpClient) -> None:
        self._clients[name] = client

    def client(self, name: str) -> McpClient | None:
        return self._clients.get(name)

    def remove_client(self, name: str) -> McpClient | None:
        return self._clients.pop(name, None)

    async def stop(self) -> None:
        for client in self._clients.values():
            try:
                await client.close()
            except Exception:
                # Best-effort cleanup
                pass
        self._clients.clear()
