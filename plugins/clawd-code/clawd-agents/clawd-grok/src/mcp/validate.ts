import type { McpRemoteTransport, McpServerConfig } from "../utils/settings";

export function isRemoteTransport(value: string): value is McpRemoteTransport {
  return value === "http" || value === "sse";
}

export function toMcpServerId(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return base || "mcp-server";
}

export function validateMcpServerConfig(server: McpServerConfig): { ok: true } | { ok: false; error: string } {
  if (!server.id.trim()) {
    return { ok: false, error: "Server id is required." };
  }

  if (!server.label.trim()) {
    return { ok: false, error: "Server label is required." };
  }

  if (isRemoteTransport(server.transport)) {
    if (!server.url?.trim()) {
      return { ok: false, error: "URL is required for HTTP/SSE MCP servers." };
    }

    try {
      const url = new URL(server.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, error: "URL must start with http:// or https://." };
      }
    } catch {
      return { ok: false, error: "URL is invalid." };
    }

    return { ok: true };
  }

  if (!server.command?.trim()) {
    return { ok: false, error: "Command is required for stdio MCP servers." };
  }

  return { ok: true };
}
