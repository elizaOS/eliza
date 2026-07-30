/**
 * Shared-runtime REST compatibility adapter for hosted app shell probes and
 * workflow capability gates.
 *
 * Tier-0 agents have no full agent server, so this route synthesizes the
 * already-provisioned startup responses needed to reach chat, plus the shell's
 * routine probes (runtime mode, slash-command catalog, custom actions, agent
 * events, stream settings, overlay presence, view navigation) — each answered
 * with this tier's honest state rather than left to 404 into a client error
 * path. It also translates the app's `/api/automations`, `/api/workflow/*`, and
 * LifeOps activity-signal requests into the canonical typed
 * capability-unavailable response. Generated routing mounts the specific
 * conversation, health, identity, and wallet siblings first; unknown catch-all
 * paths remain 404. Dedicated agents use their own subdomain and never enter
 * this adapter.
 */
import { type Context, Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestAgentEvents,
  sharedRestAuthMe,
  sharedRestCharacter,
  sharedRestCommands,
  sharedRestConfig,
  sharedRestCustomActions,
  sharedRestFirstRun,
  sharedRestFirstRunStatus,
  sharedRestFirstRunSubmit,
  sharedRestGreeting,
  sharedRestOverlayPresence,
  sharedRestRuntimeMode,
  sharedRestStatus,
  sharedRestStreamSettings,
  sharedRestViewNavigate,
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

/** `views/<viewId>/navigate` → `<viewId>`; null for any other shape. */
function viewNavigateTarget(path: string): string | null {
  const m = /^views\/([^/]+)\/navigate$/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

/** `conversations/<id>/greeting` → `<id>`; null for any other shape. */
function greetingConversationId(path: string): string | null {
  const m = /^conversations\/([^/]+)\/greeting$/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * LifeOps activity-signal ingestion requires the personal-assistant plugin's
 * scheduled-task runtime, which only a dedicated agent runs. Returning a typed
 * capability gate — rather than the bare 404 this path used to fall through to —
 * is what lets the client's capture loop latch off after one attempt instead of
 * re-reporting "unexpected capture failure" for every page-visibility and
 * interaction signal (`plugins/plugin-personal-assistant/src/lifeops/
 * activity-signals-capture.ts`). 503 is deliberate: it is the status that
 * client's `isRuntimeUnavailableError()` already recognizes for this exact path
 * as "the LifeOps runtime is not answering — stop sending".
 */
function lifeopsUnavailable(c: Context<AppEnv>): Response {
  return json(
    c,
    {
      success: false,
      code: "lifeops_runtime_unavailable",
      error:
        "LifeOps activity signals require a dedicated agent runtime; this shared agent does not ingest them.",
      capability: "lifeops-activity-signals",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
    },
    503,
  );
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
    case "runtime/mode":
      return json(c, sharedRestRuntimeMode());
    case "commands":
      return json(c, sharedRestCommands());
    case "custom-actions":
      return json(c, sharedRestCustomActions());
    case "agent/events":
      return json(c, sharedRestAgentEvents());
    case "stream/settings":
      return json(c, sharedRestStreamSettings());
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
  if (path === "lifeops/activity-signals") {
    return lifeopsUnavailable(c);
  }
  // Overlay presence is foreground-app telemetry with no store behind it on
  // this tier — ack rather than 404 a signal the shell emits on every view
  // change.
  if (path === "apps/overlay-presence") {
    return json(c, sharedRestOverlayPresence());
  }
  const navigateTarget = viewNavigateTarget(path);
  if (navigateTarget !== null) {
    const navigated = sharedRestViewNavigate(navigateTarget);
    // A view this tier does not serve stays a 404 — see sharedRestViewNavigate.
    if (navigated) return json(c, navigated);
  }
  const greetingConvId = greetingConversationId(path);
  if (greetingConvId !== null) {
    const greeting = sharedRestGreeting(r.agentId, r.agentName, greetingConvId);
    // A non-canonical conversation stays a 404 — see sharedRestGreeting.
    if (greeting) return json(c, greeting);
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
