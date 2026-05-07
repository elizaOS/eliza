import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

const bridgeRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

const CONTROL_PLANE_URL_KEYS = [
  "CONTAINER_CONTROL_PLANE_URL",
  "CONTAINER_SIDECAR_URL",
  "HETZNER_CONTAINER_CONTROL_PLANE_URL",
] as const;

function readControlPlaneEnv(c: AppContext | undefined, keys: readonly string[]): string | null {
  if (!c?.env) return null;
  for (const key of keys) {
    const value = c.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function forwardBridgeToControlPlane(params: {
  ctx?: AppContext;
  request: Request;
  agentId: string;
  user: { id: string; organization_id: string };
  body: BridgeRequest;
}): Promise<Response | null> {
  const baseUrl = readControlPlaneEnv(params.ctx, CONTROL_PLANE_URL_KEYS);
  if (!baseUrl) return null;

  const target = new URL(baseUrl);
  target.pathname = `/api/v1/eliza/agents/${encodeURIComponent(params.agentId)}/bridge`;

  const headers = new Headers(params.request.headers);
  headers.delete("host");
  const internalToken = readControlPlaneEnv(params.ctx, ["CONTAINER_CONTROL_PLANE_TOKEN"]);
  if (internalToken) headers.set("x-container-control-plane-token", internalToken);
  const databaseUrl = readControlPlaneEnv(params.ctx, ["DATABASE_URL"]);
  if (databaseUrl) headers.set("x-eliza-cloud-database-url", databaseUrl);
  headers.set("content-type", "application/json");
  headers.set("x-eliza-user-id", params.user.id);
  headers.set("x-eliza-organization-id", params.user.organization_id);

  return fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
}

/**
 * POST /api/v1/eliza/agents/[agentId]/bridge
 * Forward a JSON-RPC request to the sandbox bridge server.
 *
 * Supported methods:
 *   - message.send  { text: string, roomId?: string }
 *   - status.get    {}
 *   - heartbeat     {}
 */
async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
  ctx?: AppContext,
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const body = await request.json();

    const parsed = bridgeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid JSON-RPC request",
            details: parsed.error.issues,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const rpcRequest = parsed.data as BridgeRequest;
    if (rpcRequest.method === "message.send") {
      const response = await elizaSandboxService.bridge(agentId, user.organization_id, rpcRequest);
      return applyCorsHeaders(Response.json(response), CORS_METHODS);
    }

    const forwarded = await forwardBridgeToControlPlane({
      ctx,
      request,
      agentId,
      user,
      body: rpcRequest,
    });
    if (forwarded) {
      return applyCorsHeaders(forwarded, CORS_METHODS);
    }

    const response = await elizaSandboxService.bridge(agentId, user.organization_id, rpcRequest);

    return applyCorsHeaders(Response.json(response), CORS_METHODS);
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }, c),
);
export default __hono_app;
