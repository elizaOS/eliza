/**
 * Real MCP connection test.
 *
 * For a user-created MCP this hits `GET /api/mcp/proxy/:mcpId`, which the
 * cloud-api answers from the persisted record only when the MCP is `live` and
 * its container/external endpoint is configured (it 404s a non-live MCP). So a
 * 2xx here genuinely means the registry considers the MCP reachable.
 *
 * For a built-in platform MCP (eliza-cloud-mcp, time, weather, …) there is no
 * proxy id, so we probe the metadata sibling of the declared endpoint
 * (`/api/mcp` → `/api/mcp/info`, `/api/mcps/<x>` → `/api/mcps/<x>`), then fall
 * back to a JSON-RPC `initialize` handshake. A 401/402 still counts as "online"
 * (the server answered; it just requires auth/credits).
 */

import { ApiError, api } from "../../lib/api-client";
import type { McpProxyInfoResponse } from "./api-types";

export interface McpConnectionTestResult {
  ok: boolean;
  /** Human-readable status summary. */
  summary: string;
  /** Raw payload (pretty-printed) for the response panel. */
  detail: string;
  /** HTTP status when the server responded; `0` for a transport failure. */
  status: number;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Probe a live user MCP through the registry proxy info route. */
export async function testUserMcpConnection(
  mcpId: string,
): Promise<McpConnectionTestResult> {
  try {
    const info = await api<McpProxyInfoResponse>(`/api/mcp/proxy/${mcpId}`);
    return {
      ok: true,
      status: 200,
      summary: `${info.name} is reachable (${info.tools.length} tools)`,
      detail: pretty(info),
    };
  } catch (error) {
    if (error instanceof ApiError) {
      // 401/402 = the server answered but wants auth/credits → still "online".
      if (error.status === 401 || error.status === 402) {
        return {
          ok: true,
          status: error.status,
          summary: "Server is online (requires auth/credits)",
          detail: pretty({ status: error.status, body: error.body }),
        };
      }
      return {
        ok: false,
        status: error.status,
        summary: `Server returned ${error.status}`,
        detail: pretty({
          status: error.status,
          body: error.body ?? error.message,
        }),
      };
    }
    return {
      ok: false,
      status: 0,
      summary: "Connection failed",
      detail: pretty({
        error: error instanceof Error ? error.message : String(error),
        hint: "The MCP may be offline, unpublished, or unreachable.",
      }),
    };
  }
}

/** Resolve a built-in MCP endpoint to its metadata probe URL. */
export function builtinMetadataUrl(endpoint: string): string {
  if (endpoint === "/api/mcp") return "/api/mcp/info";
  return endpoint.replace(/\/(sse|mcp|http)$/, "");
}

/** Probe a built-in platform MCP by its declared endpoint. */
export async function testBuiltinMcpConnection(
  endpoint: string,
  name: string,
): Promise<McpConnectionTestResult> {
  const metadataUrl = builtinMetadataUrl(endpoint);

  // 1) Try the metadata sibling (unauthenticated info route).
  try {
    const data = await api<unknown>(metadataUrl);
    return {
      ok: true,
      status: 200,
      summary: `${name} is responding`,
      detail: pretty(data),
    };
  } catch (metadataError) {
    // 2) Fall back to a JSON-RPC initialize handshake at the endpoint itself.
    try {
      const data = await api<unknown>(endpoint, {
        method: "POST",
        json: {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "eliza-cloud-test", version: "1.0.0" },
          },
          id: `test-${Date.now()}`,
        },
      });
      return {
        ok: true,
        status: 200,
        summary: `${name} is responding`,
        detail: pretty(data),
      };
    } catch (initError) {
      if (initError instanceof ApiError) {
        if (initError.status === 401 || initError.status === 402) {
          return {
            ok: true,
            status: initError.status,
            summary: `${name} is online (requires auth)`,
            detail: pretty({ status: initError.status, body: initError.body }),
          };
        }
        return {
          ok: false,
          status: initError.status,
          summary: `Server returned ${initError.status}`,
          detail: pretty({ status: initError.status, body: initError.body }),
        };
      }
      const message =
        metadataError instanceof Error
          ? metadataError.message
          : String(metadataError);
      return {
        ok: false,
        status: 0,
        summary: "Connection failed",
        detail: pretty({
          error: message,
          hint: "The server may be offline or unreachable.",
        }),
      };
    }
  }
}
