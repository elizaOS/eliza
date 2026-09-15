/**
 * /api/mcp — Eliza Cloud platform MCP (streamable-http).
 *
 * When `ELIZA_CLOUD_PLATFORM_MCP_UPSTREAM_URL` is set to an HTTPS MCP endpoint,
 * requests are proxied there. Otherwise the Worker serves a local JSON-RPC MCP
 * surface for Cloud account, billing, app, agent, container, and admin tools.
 */

import { Hono } from "hono";

import { safeUnknownErrorMessage } from "@/lib/api/cloud-worker-errors";
import {
  requireAdmin,
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg,
} from "@/lib/auth/workers-hono-auth";
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

const CONFIGURED_UPSTREAM_NON_MUTATING_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
]);

type ConfiguredUpstreamClassification =
  | { kind: "non_mutating"; id: unknown }
  | {
      kind: "tool";
      id: unknown;
      authority: "member" | "billing_manager" | "admin";
      effect: "read" | "mutation";
    }
  | { kind: "invalid"; id: unknown; message: string };

/**
 * Positively classifies the MCP protocol envelope, independent of tool names,
 * paths, aliases, versions, or upstream-specific argument vocabulary.
 */
export function classifyConfiguredUpstreamMessage(
  message: unknown,
): ConfiguredUpstreamClassification {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { kind: "invalid", id: null, message: "Invalid JSON-RPC request" };
  }
  const request = message as {
    id?: unknown;
    method?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  const id = request.id ?? null;
  if (typeof request.method !== "string" || request.method.length === 0) {
    return { kind: "invalid", id, message: "JSON-RPC method is required" };
  }
  if (request.method === "tools/call") {
    if (
      typeof request.params?.name !== "string" ||
      request.params.name.length === 0
    ) {
      return {
        kind: "invalid",
        id,
        message: "tools/call params.name is required",
      };
    }
    const definition = listPlatformCloudMcpTools().find(
      (tool) => tool.name === request.params?.name,
    );
    if (!definition) {
      return {
        kind: "invalid",
        id,
        message: `Unknown configured-upstream tool: ${request.params.name}`,
      };
    }
    const input =
      request.params.arguments &&
      typeof request.params.arguments === "object" &&
      !Array.isArray(request.params.arguments)
        ? (request.params.arguments as Record<string, unknown>)
        : {};
    const nested =
      input.params &&
      typeof input.params === "object" &&
      !Array.isArray(input.params)
        ? (input.params as Record<string, unknown>)
        : {};
    const requestedMethod =
      typeof input.method === "string"
        ? input.method.toUpperCase()
        : typeof nested.method === "string"
          ? nested.method.toUpperCase()
          : undefined;
    const requestedEffect =
      requestedMethod === undefined
        ? undefined
        : requestedMethod === "GET" || requestedMethod === "HEAD"
          ? "read"
          : "mutation";
    if (
      requestedEffect !== undefined &&
      definition.access.effect !== "dynamic" &&
      requestedEffect !== definition.access.effect
    ) {
      return {
        kind: "invalid",
        id,
        message: `Tool ${definition.name} does not permit a ${requestedEffect} method override`,
      };
    }
    const effect =
      requestedEffect !== undefined
        ? requestedEffect
        : definition.access.effect === "dynamic"
          ? "mutation"
          : definition.access.effect;
    const authority =
      definition.access.effect === "dynamic" &&
      definition.access.authority === "billing_manager" &&
      effect === "read"
        ? "member"
        : definition.access.authority;
    return {
      kind: "tool",
      id,
      effect,
      authority,
    };
  }
  if (CONFIGURED_UPSTREAM_NON_MUTATING_METHODS.has(request.method)) {
    return { kind: "non_mutating", id };
  }
  return {
    kind: "invalid",
    id,
    message: `Unsupported configured-upstream MCP method: ${request.method}`,
  };
}

async function authorizeConfiguredUpstreamMessages(
  c: AppContext,
  body: unknown,
): Promise<Response | null> {
  const messages = Array.isArray(body) ? body : [body];
  const classifications = messages.map(classifyConfiguredUpstreamMessage);
  const invalid = classifications.filter((entry) => entry.kind === "invalid");
  if (invalid.length > 0) {
    const errors = classifications.map((entry) =>
      entry.kind === "invalid"
        ? jsonRpcError(entry.id, -32601, entry.message)
        : jsonRpcError(
            entry.id,
            -32600,
            "Batch was not forwarded because a method was unclassified",
          ),
    );
    return c.json(Array.isArray(body) ? errors : errors[0], 400);
  }
  const tools = classifications.filter((entry) => entry.kind === "tool");
  if (tools.length === 0) return null;

  try {
    const authorities = new Set(tools.map((entry) => entry.authority));
    if (authorities.has("admin")) {
      await requireAdmin(c);
    }
    if (authorities.has("billing_manager")) {
      await requireCurrentBillingManagerSession(c);
    }
    if (authorities.has("member")) {
      await requireUserOrApiKeyWithOrg(c);
    }
    return null;
  } catch (error) {
    // error-policy:J1 the MCP transport boundary returns a JSON-RPC denial and
    // never forwards the privileged envelope or credential-bearing request.
    logger.error("[MCP] Configured-upstream tool authorization failed", {
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
  if (!["GET", "HEAD", "POST"].includes(c.req.raw.method)) {
    return c.json(
      jsonRpcError(
        null,
        -32600,
        "Configured MCP transport only accepts GET or POST",
      ),
      405,
    );
  }
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
    const rejection = await authorizeConfiguredUpstreamMessages(c, body);
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
        // error-policy:J1 local tool execution failures become redacted
        // JSON-RPC errors at the transport boundary.
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
    // error-policy:J3 malformed transport JSON is rejected explicitly.
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
