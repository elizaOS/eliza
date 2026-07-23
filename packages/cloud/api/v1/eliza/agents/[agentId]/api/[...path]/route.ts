/**
 * Shared-runtime REST compatibility adapter for hosted app shell probes and
 * workflow capability gates.
 *
 * Tier-0 agents have no full agent server, so this route synthesizes the
 * already-provisioned startup responses needed to reach chat. It also
 * translates the app's `/api/automations` and `/api/workflow/*` requests into
 * the canonical typed dedicated-runtime response. Generated routing mounts
 * the specific conversation, health, identity, and wallet siblings first;
 * unknown catch-all paths remain 404. Dedicated agents use their own subdomain
 * and never enter this adapter.
 */
import { type Context, Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestAuthMe,
  sharedRestCharacter,
  sharedRestConfig,
  sharedRestFirstRun,
  sharedRestFirstRunStatus,
  sharedRestFirstRunSubmit,
  sharedRestStatus,
  sharedRestViews,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";
import { workflowRuntimeUnavailableResponse } from "../../workflows/_shared";

const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

const app = new Hono<AppEnv>();

function json(c: Context<AppEnv>, data: unknown, status?: number): Response {
  return applyCorsHeaders(
    status ? Response.json(data, { status }) : Response.json(data),
    CORS_METHODS,
    c.req.header("origin"),
  );
}

function shellPath(c: Context<AppEnv>): string {
  const raw = c.req.param("*") ?? "";
  return raw
    .split("/")
    .filter((s) => s.length > 0)
    .join("/");
}

function isWorkflowApiPath(path: string): boolean {
  return path === "workflow" || path.startsWith("workflow/");
}

function workflowUnavailable(
  c: Context<AppEnv>,
  agentId: string,
  executionTier: Parameters<typeof workflowRuntimeUnavailableResponse>[1],
): Response {
  return applyCorsHeaders(
    workflowRuntimeUnavailableResponse(agentId, executionTier),
    CORS_METHODS,
    c.req.header("origin"),
  );
}

app.options("/", (c) =>
  handleCorsOptions(CORS_METHODS, c.req.header("origin")),
);

app.get("/", async (c) => {
  const path = shellPath(c);
  if (path === "character") {
    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    if ("error" in worker) {
      return json(
        c,
        {
          success: false,
          error: worker.error,
          code: worker.code,
          retryable: worker.retryable,
        },
        worker.status,
      );
    }
    const characterAgent = await resolveSharedAgent(c, {
      cacheOnly: true,
      executionCtx: worker.executionCtx,
    });
    if ("error" in characterAgent) {
      return json(
        c,
        {
          success: false,
          error: characterAgent.error,
          ...(characterAgent.status === 503 ? { retryable: true } : {}),
        },
        characterAgent.status,
      );
    }
    try {
      return json(
        c,
        await sharedRestCharacter(
          characterAgent.agent,
          characterAgent.agentName,
          worker.executionCtx,
        ),
      );
    } catch (error) {
      // error-policy:J1 the HTTP boundary preserves a cache miss as retryable
      // unavailability; it must not become an opaque 500 or trigger a fallback.
      if (
        error instanceof Error &&
        error.name === "SharedRuntimeCacheWarmingError"
      ) {
        return json(
          c,
          {
            success: false,
            error: error.message,
            code: "shared_runtime_cache_warming",
            retryable: true,
          },
          503,
        );
      }
      throw error;
    }
  }
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return json(c, { success: false, error: r.error }, r.status);
  }
  // The app's workflow clients use the full-runtime compatibility paths. A
  // shared agent cannot serve them, so surface the same typed capability gate
  // as the canonical `/workflows` proxy instead of an unrelated shell 404.
  if (path === "automations" || isWorkflowApiPath(path)) {
    return workflowUnavailable(c, r.agentId, r.agent.execution_tier);
  }
  switch (path) {
    case "status":
      // The startup-coordinator's first gate — must answer before first-run.
      return json(c, sharedRestStatus(r.agentName));
    case "first-run/status":
      return json(c, sharedRestFirstRunStatus());
    case "first-run":
      return json(c, sharedRestFirstRun());
    case "views":
      return json(c, sharedRestViews(c.req.query("viewType")));
    case "config":
      return json(c, sharedRestConfig());
    case "auth/me":
      // The app's hard startup auth gate. The caller is already an authed API
      // key (resolveSharedAgent validated it), so report the authed machine
      // identity instead of 404'ing into "server_unavailable".
      return json(c, sharedRestAuthMe(r.agentId, r.agentName));
    default:
      // Genuinely-unknown shell endpoint — don't mask it with a default.
      return json(
        c,
        { success: false, error: "Not found", code: "resource_not_found" },
        404,
      );
  }
});

app.post("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return json(c, { success: false, error: r.error }, r.status);
  }
  const path = shellPath(c);
  if (isWorkflowApiPath(path)) {
    return workflowUnavailable(c, r.agentId, r.agent.execution_tier);
  }
  // Onboarding "submit" — a shared agent has no config to persist, so accept it
  // as a harmless no-op instead of 404'ing onboarding.
  if (path === "first-run") {
    return json(c, sharedRestFirstRunSubmit());
  }
  return json(
    c,
    { success: false, error: "Not found", code: "resource_not_found" },
    404,
  );
});

async function handleWorkflowMutation(c: Context<AppEnv>): Promise<Response> {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return json(c, { success: false, error: r.error }, r.status);
  }
  if (isWorkflowApiPath(shellPath(c))) {
    return workflowUnavailable(c, r.agentId, r.agent.execution_tier);
  }
  return json(
    c,
    { success: false, error: "Not found", code: "resource_not_found" },
    404,
  );
}

app.put("/", handleWorkflowMutation);
app.delete("/", handleWorkflowMutation);

export default app;
