/**
 * /api/mcp — Eliza Cloud platform MCP (streamable-http).
 *
 * When `ELIZA_CLOUD_PLATFORM_MCP_UPSTREAM_URL` is set to an HTTPS MCP endpoint,
 * requests are proxied there. Otherwise the Worker serves a local JSON-RPC MCP
 * surface for Cloud account, billing, app, agent, container, and admin tools.
 */

import { Hono } from "hono";

import { safeUnknownErrorMessage } from "@/lib/api/cloud-worker-errors";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import { forwardMcpUpstreamRequest } from "@/lib/mcp/mcp-upstream-forward";
import {
  callPlatformCloudMcpTool,
  listPlatformCloudMcpTools,
} from "@/lib/mcp/platform-cloud-tools";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const PLATFORM_UPSTREAM_ENV = "ELIZA_CLOUD_PLATFORM_MCP_UPSTREAM_URL";

const app = new Hono<AppEnv>();

function getPlatformUpstream(c: AppContext): string | null {
  const raw = c.env[PLATFORM_UPSTREAM_ENV];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function jsonRpcResult(id: unknown, result: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

function isBillingCancellationCall(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message))
    return false;
  const request = message as {
    method?: unknown;
    params?: {
      name?: unknown;
      arguments?: { method?: unknown; path?: unknown };
    };
  };
  if (request.method !== "tools/call") return false;
  if (
    request.params?.name === "cloud.billing.cancel_resource" ||
    request.params?.name === "billing.cancel_resource"
  ) {
    return true;
  }
  if (request.params?.name !== "cloud.api.request") return false;
  const generic = request.params.arguments;
  if (
    typeof generic?.method !== "string" ||
    generic.method.toUpperCase() !== "POST"
  ) {
    return false;
  }
  if (typeof generic.path !== "string" || !generic.path.startsWith("/api/"))
    return false;

  try {
    let pathname = new URL(generic.path, "https://mcp-gate.invalid").pathname;
    for (let pass = 0; pass < 2; pass += 1) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = new URL(decoded, "https://mcp-gate.invalid").pathname;
    }
    return /^\/api\/v1\/billing\/resources\/[^/]+\/cancel\/?$/.test(pathname);
  } catch {
    // error-policy:J3 malformed generic paths are not trusted to bypass a
    // privileged pre-forward gate when they still name billing cancellation.
    return /billing/i.test(generic.path) && /cancel/i.test(generic.path);
  }
}

async function rejectUnauthorizedUpstreamBillingCalls(
  c: AppContext,
  body: unknown,
): Promise<Response | null> {
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.some(isBillingCancellationCall)) return null;

  try {
    await requireCurrentBillingManagerSession(c);
    return null;
  } catch (error) {
    logger.error("[MCP] Upstream billing cancellation authorization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = safeUnknownErrorMessage(error);
    const errors = messages.map((entry) => {
      const id =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as { id?: unknown }).id
          : null;
      return jsonRpcError(id, -32000, message);
    });
    return c.json(Array.isArray(body) ? errors : errors[0]);
  }
}

async function forwardConfiguredMcpRequest(
  c: AppContext,
  upstream: string,
): Promise<Response> {
  if (
    c.req.raw.method !== "GET" &&
    c.req.raw.method !== "HEAD" &&
    c.req.raw.body !== null
  ) {
    let body: unknown;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      // error-policy:J3 configured upstream requests remain local when their
      // untrusted JSON cannot be inspected for privileged billing calls.
      return c.json(jsonRpcError(null, -32700, "Invalid JSON"), 400);
    }
    const rejection = await rejectUnauthorizedUpstreamBillingCalls(c, body);
    if (rejection) return rejection;
  }
  return forwardMcpUpstreamRequest(c.req.raw, upstream);
}

async function handleJsonRpc(c: AppContext, message: unknown) {
  const request = message as {
    id?: unknown;
    method?: string;
    params?: {
      name?: string;
      arguments?: unknown;
    };
  };

  switch (request.method) {
    case "initialize":
      return jsonRpcResult(request.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: {
          name: "eliza-cloud-platform",
          version: "1.0.0",
        },
      });
    case "ping":
      return jsonRpcResult(request.id, {});
    case "tools/list":
      return jsonRpcResult(request.id, {
        tools: listPlatformCloudMcpTools(),
      });
    case "tools/call": {
      const toolName = request.params?.name;
      if (!toolName)
        return jsonRpcError(request.id, -32602, "params.name is required");
      try {
        const result = await callPlatformCloudMcpTool(
          c,
          toolName,
          request.params?.arguments ?? {},
        );
        return jsonRpcResult(request.id, result);
      } catch (error) {
        // Redact: deliberate 4xx errors (auth/validation/not-found) keep their
        // message; infra/DB/5xx faults collapse to a generic string so raw SQL /
        // SQLSTATE / driver internals never reach the MCP caller. Full error is
        // logged server-side.
        logger.error("[MCP] tools/call failed", {
          tool: toolName,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonRpcError(request.id, -32000, safeUnknownErrorMessage(error));
      }
    }
    default:
      return jsonRpcError(
        request.id,
        -32601,
        `Unsupported MCP method: ${request.method}`,
      );
  }
}

app.get("/", async (c) => {
  const upstream = getPlatformUpstream(c);
  if (upstream) {
    return forwardMcpUpstreamRequest(c.req.raw, upstream);
  }

  return c.json({
    success: true,
    name: "eliza-cloud-platform",
    protocol: "mcp",
    transport: "streamable-http",
    tools: listPlatformCloudMcpTools().map((tool) => tool.name),
  });
});

app.post("/", async (c) => {
  const upstream = getPlatformUpstream(c);
  if (upstream) {
    return forwardConfiguredMcpRequest(c, upstream);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, "Invalid JSON"), 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const results = await Promise.all(
    messages.map((message) => handleJsonRpc(c, message)),
  );
  return c.json(Array.isArray(body) ? results : results[0]);
});

app.all("*", async (c) => {
  const upstream = getPlatformUpstream(c);
  if (upstream) return forwardConfiguredMcpRequest(c, upstream);
  return c.json(
    { success: false, error: "MCP method/path not supported" },
    405,
  );
});

export default app;
