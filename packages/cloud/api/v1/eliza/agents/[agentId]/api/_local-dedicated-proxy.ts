/**
 * Owner-scoped loopback hop that lets the local cloud harness reach a Dedicated
 * Docker runtime through the Shared REST path family.
 *
 * Production routes Dedicated traffic to a per-agent hostname, so this
 * middleware is inert unless `ELIZA_CLOUD_AGENT_BASE_DOMAIN` is the explicit
 * `https://` sentinel (no DNS host to synthesize). Every Hono leaf under
 * `/api/v1/eliza/agents/:agentId/api` registers it first so a client pointed at
 * `personalDedicatedClientApiBase` never falls into a Shared-only handler for a
 * running Dedicated agent. The Cloud session stays on the Cloud side: ownership
 * is re-checked per request, cookies and Cloud credentials are stripped, and
 * the runtime's own `ELIZA_API_TOKEN` is swapped in as the bearer.
 */
import type { Context, Next } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  dedicatedAgentTransportToken,
  personalDedicatedAgentApiBase,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEDICATED_AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function continueToNext(next: Next): Promise<undefined> {
  await next();
  return undefined;
}

function runtimeApiPath(requestUrl: string, agentId: string): string | null {
  const pathname = new URL(requestUrl).pathname;
  const marker = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/api`;
  if (pathname !== marker && !pathname.startsWith(`${marker}/`)) return null;
  return pathname.slice(marker.length) || "";
}

/**
 * Forward an owner's request to the loopback Dedicated runtime, or fall through
 * to the Shared handler when the agent is not a local Dedicated one.
 */
export async function proxyLocalDedicatedOrNext(
  c: Context<AppEnv>,
  next: Next,
): Promise<Response | undefined> {
  // Leaves mounted without bindings (unit harnesses) have no env object at
  // all; that is the same "no sentinel configured" state as production and
  // must leave the Shared handler untouched rather than throw.
  const baseDomain = c.env ? c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN : undefined;
  if (baseDomain !== "https://") {
    return continueToNext(next);
  }
  const agentId = c.req.param("agentId")?.trim() ?? "";
  if (!DEDICATED_AGENT_ID.test(agentId)) return continueToNext(next);

  const path = runtimeApiPath(c.req.url, agentId);
  if (path === null) return continueToNext(next);
  if (c.req.method === "OPTIONS") {
    return handleCorsOptions(CORS_METHODS, c.req.header("origin"));
  }

  // Loaded only once a request is eligible so Shared-only leaves that mount
  // this middleware do not pull the database client into their module graph.
  const [{ requireUserOrApiKeyWithOrg }, { agentSandboxesRepository }] =
    await Promise.all([
      import("@/lib/auth/workers-hono-auth"),
      import("@/db/repositories/agent-sandboxes"),
    ]);
  const user = await requireUserOrApiKeyWithOrg(c);
  const sandbox = await agentSandboxesRepository.findByIdAndOrg(
    agentId,
    user.organization_id,
  );
  if (!sandbox || sandbox.execution_tier === "shared") {
    return continueToNext(next);
  }
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

  const runtimeBase = personalDedicatedAgentApiBase(sandbox, baseDomain);
  const agentToken = dedicatedAgentTransportToken(sandbox);
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

  const init: RequestInit & { duplex?: "half" } = {
    method: c.req.method,
    headers,
    redirect: "manual",
  };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    // Streaming a request body requires half-duplex on Node and Bun fetch;
    // workerd ignores the flag.
    init.body = c.req.raw.body;
    init.duplex = "half";
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
