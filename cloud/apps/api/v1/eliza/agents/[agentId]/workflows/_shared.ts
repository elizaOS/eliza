import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppContext } from "@/types/cloud-worker-env";

export const WORKFLOW_CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

function envString(c: AppContext | undefined, key: string): string | null {
  const value = c?.env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveAgentServerUrl(c: AppContext, agentId: string): Promise<string | null> {
  const redis = buildRedisClient(c.env);
  if (!redis) return null;

  const serverName = await redis.get<string>(`agent:${agentId}:server`);
  if (!serverName) return null;

  const serverUrl = await redis.get<string>(`server:${serverName}:url`);
  return typeof serverUrl === "string" && serverUrl.trim() ? serverUrl.trim() : null;
}

function buildTargetUrl(serverUrl: string, requestUrl: string, agentId: string, suffix: string): URL {
  const request = new URL(requestUrl);
  const target = new URL(serverUrl);
  const normalizedSuffix = suffix ? `/${suffix.replace(/^\/+/, "")}` : "";
  target.pathname = `/agents/${encodeURIComponent(agentId)}/workflows${normalizedSuffix}`;
  target.search = request.search;
  return target;
}

async function forwardWorkflowToAgentServer(params: {
  ctx: AppContext;
  request: Request;
  agentId: string;
  suffix: string;
  user: { id: string; organization_id: string };
}): Promise<Response> {
  const serverUrl = await resolveAgentServerUrl(params.ctx, params.agentId);
  if (!serverUrl) {
    return Response.json(
      { success: false, error: "Agent workflow runtime is not available" },
      { status: 503 },
    );
  }

  const sharedSecret = envString(params.ctx, "AGENT_SERVER_SHARED_SECRET");
  if (!sharedSecret) {
    return Response.json(
      { success: false, error: "Agent-server auth is not configured" },
      { status: 503 },
    );
  }

  const headers = new Headers(params.request.headers);
  headers.delete("host");
  headers.set("x-server-token", sharedSecret);
  headers.set("x-eliza-user-id", params.user.id);
  headers.set("x-eliza-organization-id", params.user.organization_id);

  const method = params.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await params.request.arrayBuffer();
  return fetch(buildTargetUrl(serverUrl, params.request.url, params.agentId, params.suffix), {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
}

export async function handleWorkflowProxyRequest(
  request: Request,
  agentId: string,
  suffix: string,
  ctx: AppContext,
): Promise<Response> {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const forwarded = await forwardWorkflowToAgentServer({
      ctx,
      request,
      agentId,
      suffix,
      user,
    });
    return applyCorsHeaders(forwarded, WORKFLOW_CORS_METHODS);
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), WORKFLOW_CORS_METHODS);
  }
}

export function handleWorkflowProxyOptions(): Response {
  return handleCorsOptions(WORKFLOW_CORS_METHODS);
}
