/**
 * Agent-bound Google MCP execution broker for Cloud Mode A/B credentials. It
 * resolves the private credential from a public binding, injects only a
 * short-lived access token upstream, and enforces the curated preview surface.
 */

import { GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES } from "@elizaos/shared/contracts";
import type { AgentConnectorBindingsService } from "./agent-connector-bindings";
import { agentConnectorBindingsService } from "./agent-connector-bindings";
import { oauthService } from "./oauth";

export const GOOGLE_MCP_BROKER_PRODUCTS = {
  gmail: {
    endpoint: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.endpoint,
    capability: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.capability,
    scopes: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.acceptedScopes,
    tools: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.curatedTools,
  },
  calendar: {
    endpoint: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.endpoint,
    capability: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.capability,
    scopes: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.acceptedScopes,
    tools: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.curatedTools,
  },
} as const;

export type GoogleMcpBrokerProduct = keyof typeof GOOGLE_MCP_BROKER_PRODUCTS;

export class GoogleMcpBrokerError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 502,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleMcpBrokerError";
  }
}

export type GoogleMcpBrokerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface GoogleMcpBrokerDeps {
  bindings: Pick<AgentConnectorBindingsService, "getExecutionBinding">;
  getValidToken: (args: {
    organizationId: string;
    connectionId: string;
    platform: string;
  }) => Promise<{ accessToken: string }>;
  fetch: GoogleMcpBrokerFetch;
}

interface JsonRpcRequest {
  method?: unknown;
  params?: unknown;
}

const ALLOWED_MCP_METHODS = new Set([
  "server/discover",
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requestEnvelope(body: Uint8Array | undefined): JsonRpcRequest | null {
  if (!body || body.byteLength === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new GoogleMcpBrokerError(400, "MCP_REQUEST_INVALID", "MCP body must be valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new GoogleMcpBrokerError(
      400,
      "MCP_REQUEST_INVALID",
      "MCP body must be one JSON request object.",
    );
  }
  return parsed;
}

function requestMethod(headers: Headers, envelope: JsonRpcRequest | null): string | null {
  const headerMethod = headers.get("mcp-method");
  const bodyMethod = typeof envelope?.method === "string" ? envelope.method : null;
  if (headerMethod && bodyMethod && headerMethod !== bodyMethod) {
    throw new GoogleMcpBrokerError(
      400,
      "MCP_REQUEST_MISMATCH",
      "MCP method header does not match the request body.",
    );
  }
  return headerMethod ?? bodyMethod;
}

function requestedTool(headers: Headers, envelope: JsonRpcRequest | null): string | null {
  const headerName = headers.get("mcp-name");
  const bodyName =
    isRecord(envelope?.params) && typeof envelope.params.name === "string"
      ? envelope.params.name
      : null;
  if (headerName && bodyName && headerName !== bodyName) {
    throw new GoogleMcpBrokerError(
      400,
      "MCP_REQUEST_MISMATCH",
      "MCP tool header does not match the request body.",
    );
  }
  return headerName ?? bodyName;
}

function upstreamHeaders(requestHeaders: Headers, accessToken: string): Headers {
  const headers = new Headers({
    accept: requestHeaders.get("accept") ?? "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": requestHeaders.get("content-type") ?? "application/json",
  });
  for (const name of ["mcp-protocol-version", "mcp-method", "mcp-name"]) {
    const value = requestHeaders.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "cache-control",
    "etag",
    "mcp-protocol-version",
    "mcp-session-id",
    "retry-after",
    "www-authenticate",
  ]) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function filterTools(payload: unknown, allowed: ReadonlySet<string>): unknown {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
    throw new GoogleMcpBrokerError(
      502,
      "MCP_UPSTREAM_RESPONSE_INVALID",
      "Google MCP returned an invalid tools/list response.",
    );
  }
  return {
    ...payload,
    result: {
      ...payload.result,
      tools: payload.result.tools.filter(
        (tool) => isRecord(tool) && typeof tool.name === "string" && allowed.has(tool.name),
      ),
    },
  };
}

export function createGoogleMcpBroker(deps: GoogleMcpBrokerDeps) {
  return {
    async forward(args: {
      organizationId: string;
      agentId: string;
      bindingId: string;
      product: string;
      method: string;
      headers: Headers;
      body?: Uint8Array;
      signal?: AbortSignal;
    }): Promise<Response> {
      const product = args.product.toLowerCase() as GoogleMcpBrokerProduct;
      const config = GOOGLE_MCP_BROKER_PRODUCTS[product];
      if (!config) {
        throw new GoogleMcpBrokerError(
          404,
          "GOOGLE_MCP_PRODUCT_NOT_FOUND",
          "Google MCP product is not enabled.",
        );
      }
      if (args.method.toUpperCase() !== "POST") {
        throw new GoogleMcpBrokerError(400, "MCP_METHOD_INVALID", "Unsupported MCP HTTP method.");
      }
      const execution = await deps.bindings.getExecutionBinding({
        organizationId: args.organizationId,
        agentId: args.agentId,
        bindingId: args.bindingId,
        provider: "google",
      });
      const { binding } = execution;
      if (
        binding.status !== "connected" ||
        binding.executionTarget !== "cloud_broker" ||
        execution.credentialStatus !== "active"
      ) {
        throw new GoogleMcpBrokerError(
          409,
          "GOOGLE_MCP_BINDING_UNAVAILABLE",
          "Google connector binding requires reconnection.",
        );
      }
      if (
        !binding.selectedProducts.map((value) => value.toLowerCase()).includes(product) ||
        !binding.allowedCapabilities.includes(config.capability) ||
        !config.scopes.some((scope) => binding.grantedScopes.includes(scope))
      ) {
        throw new GoogleMcpBrokerError(
          403,
          "GOOGLE_MCP_CAPABILITY_DENIED",
          "Google connector binding does not grant this product capability.",
        );
      }

      const envelope = requestEnvelope(args.body);
      const protocolMethod = requestMethod(args.headers, envelope);
      if (protocolMethod && !ALLOWED_MCP_METHODS.has(protocolMethod)) {
        throw new GoogleMcpBrokerError(
          403,
          "GOOGLE_MCP_METHOD_DENIED",
          "Google MCP method is outside the curated execution surface.",
        );
      }
      if (args.body?.byteLength && !protocolMethod) {
        throw new GoogleMcpBrokerError(
          400,
          "MCP_REQUEST_INVALID",
          "MCP request does not declare a method.",
        );
      }
      const allowedTools = new Set<string>(config.tools);
      if (protocolMethod === "tools/call") {
        const tool = requestedTool(args.headers, envelope);
        if (!tool || !allowedTools.has(tool)) {
          throw new GoogleMcpBrokerError(
            403,
            "GOOGLE_MCP_TOOL_DENIED",
            "Google MCP tool is not in the curated binding manifest.",
          );
        }
      }

      const token = await deps.getValidToken({
        organizationId: args.organizationId,
        connectionId: execution.platformCredentialId,
        platform: "google",
      });
      let upstream: Response;
      try {
        upstream = await deps.fetch(config.endpoint, {
          method: args.method,
          headers: upstreamHeaders(args.headers, token.accessToken),
          ...(args.body && args.body.byteLength > 0 ? { body: requestBody(args.body) } : {}),
          redirect: "error",
          signal: args.signal,
        });
      } catch (error) {
        // error-policy:J1 The broker is the outbound transport boundary; retain
        // the failure as an explicit upstream-unavailable response.
        throw new GoogleMcpBrokerError(
          502,
          "GOOGLE_MCP_UPSTREAM_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
        );
      }

      const headers = responseHeaders(upstream.headers);
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      if (protocolMethod !== "tools/list" || !upstream.ok) {
        return new Response(bytes, { status: upstream.status, headers });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new GoogleMcpBrokerError(
          502,
          "MCP_UPSTREAM_RESPONSE_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      return Response.json(filterTools(payload, allowedTools), {
        status: upstream.status,
        headers,
      });
    },
  };
}

export const googleMcpBroker = createGoogleMcpBroker({
  bindings: agentConnectorBindingsService,
  getValidToken: (args) => oauthService.getValidToken(args),
  fetch: (input, init) => fetch(input, init),
});
