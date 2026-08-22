import type { Context, Next } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { personalDedicatedAgentApiBase } from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEDICATED_AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runtimeApiPath(requestUrl: string, agentId: string): string | null {
  const pathname = new URL(requestUrl).pathname;
  const marker = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/api`;
  if (pathname !== marker && !pathname.startsWith(`${marker}/`)) return null;
  return pathname.slice(marker.length) || "";
}

/**
 * Development-only path proxy for Dedicated Docker agents. Production uses a
 * per-agent hostname; the repository's explicit `https://` sentinel has no
 * DNS host, so this route keeps the Cloud ownership/auth boundary and forwards
 * to the validated loopback runtime after swapping in its agent credential.
 */
export async function proxyLocalDedicatedOrNext(
  c: Context<AppEnv>,
  next: Next,
): Promise<Response> {
  if (c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN !== "https://") return next();
  const agentId = c.req.param("agentId")?.trim() ?? "";
  if (!DEDICATED_AGENT_ID.test(agentId)) return next();

  const path = runtimeApiPath(c.req.url, agentId);
  if (path === null) return next();
  if (c.req.method === "OPTIONS") {
    return handleCorsOptions(CORS_METHODS, c.req.header("origin"));
  }

  const user = await requireUserOrApiKeyWithOrg(c);
  const sandbox = await agentSandboxesRepository.findByIdAndOrg(
    agentId,
    user.organization_id,
  );
  if (!sandbox || sandbox.execution_tier === "shared") return next();
  if (sandbox.status !== "running") {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          code: "agent_not_running",
          error: "Dedicated agent is not running yet",
          data: { status: sandbox.status },
        },
        { status: 503, headers: { "Retry-After": "5" } },
      ),
      CORS_METHODS,
      c.req.header("origin"),
    );
  }

  const runtimeBase = personalDedicatedAgentApiBase(
    sandbox,
    c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
  );
  const agentToken = (
    sandbox.environment_vars as Record<string, string> | null
  )?.ELIZA_API_TOKEN?.trim();
  if (!runtimeBase || !agentToken) {
    return applyCorsHeaders(
      Response.json(
        {
          success: false,
          code: "agent_unavailable",
          error: "Dedicated agent connection is unavailable",
        },
        { status: 503 },
      ),
      CORS_METHODS,
      c.req.header("origin"),
    );
  }

  const target = new URL(runtimeBase);
  target.pathname = `/api${path}`;
  target.search = new URL(c.req.url).search;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("x-api-key");
  headers.delete("x-eliza-csrf");
  headers.set("authorization", `Bearer ${agentToken}`);

  const init: RequestInit = {
    method: c.req.method,
    headers,
    redirect: "manual",
  };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = c.req.raw.body;
  }
  const upstream = await fetch(new Request(target, init));
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("set-cookie");
  responseHeaders.delete("set-cookie2");
  return applyCorsHeaders(
    new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }),
    CORS_METHODS,
    c.req.header("origin"),
  );
}
