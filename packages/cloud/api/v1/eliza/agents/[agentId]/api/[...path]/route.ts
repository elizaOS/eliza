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
import { MAX_MOBILE_PUSH_TOKEN_CHARACTERS } from "@/lib/mobile-push/types";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  coordinateSharedPushList,
  coordinateSharedPushRegister,
  coordinateSharedPushUnregister,
} from "@/lib/services/shared-runtime/conversation-coordinator";
import {
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext,
} from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestAgentEvents,
  sharedRestAgentStart,
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
const MAX_PUSH_REGISTRATION_BODY_BYTES = 8_192;

const app = new Hono<AppEnv>();

function json(
  c: Context<AppEnv>,
  data: unknown,
  status?: number,
  headers?: Record<string, string>,
): Response {
  return applyCorsHeaders(
    status ? Response.json(data, { status, headers }) : Response.json(data),
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
export function viewNavigateTarget(path: string): string | null {
  const m = /^views\/([^/]+)\/navigate$/.exec(path);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // error-policy:J3 malformed percent-escape is not a navigable view id.
    return null;
  }
}

/** `conversations/<id>/greeting` → `<id>`; null for any other shape. */
export function greetingConversationId(path: string): string | null {
  const m = /^conversations\/([^/]+)\/greeting$/.exec(path);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // error-policy:J3 malformed percent-escape is not a greeting conversation.
    return null;
  }
}

function pushTokenDeleteTarget(path: string): string | null {
  const prefix = "notifications/push-tokens/";
  if (!path.startsWith(prefix)) return null;
  const encoded = path.slice(prefix.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function isPersonalSharedAgent(
  value: Awaited<ReturnType<typeof resolveSharedAgent>>,
): boolean {
  return (
    !("error" in value) &&
    "agentKind" in value &&
    value.agentKind === "personal"
  );
}

function personalPushUnavailable(c: Context<AppEnv>): Response {
  return json(
    c,
    {
      success: false,
      error: "Mobile push is available only for Personal Shared agents",
      code: "resource_not_found",
    },
    404,
  );
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
          ...(characterAgent.code ? { code: characterAgent.code } : {}),
          ...(characterAgent.status === 503 ? { retryable: true } : {}),
        },
        characterAgent.status,
        characterAgent.retryAfterSeconds
          ? { "Retry-After": String(characterAgent.retryAfterSeconds) }
          : undefined,
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
          { "Retry-After": "1" },
        );
      }
      throw error;
    }
  }
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return json(c, { success: false, error: r.error }, r.status);
  }
  if (path === "notifications/push-tokens") {
    if (!isPersonalSharedAgent(r)) return personalPushUnavailable(c);
    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    if ("error" in worker) return json(c, worker, worker.status);
    const tokens = await coordinateSharedPushList(r.agentId, {
      namespace: worker.namespace,
    });
    return json(c, {
      count: tokens.length,
      platforms: {
        ios: tokens.filter((token) => token.platform === "ios").length,
        android: tokens.filter((token) => token.platform === "android").length,
      },
    });
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
  if (path === "notifications/push-tokens") {
    if (!isPersonalSharedAgent(r)) return personalPushUnavailable(c);
    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    if ("error" in worker) return json(c, worker, worker.status);
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_PUSH_REGISTRATION_BODY_BYTES
    ) {
      return json(c, { success: false, error: "Request body too large" }, 413);
    }
    const rawBody = await c.req.text();
    if (
      new TextEncoder().encode(rawBody).length >
      MAX_PUSH_REGISTRATION_BODY_BYTES
    ) {
      return json(c, { success: false, error: "Request body too large" }, 413);
    }
    let body: { platform?: unknown; token?: unknown } | null = null;
    try {
      body = JSON.parse(rawBody) as { platform?: unknown; token?: unknown };
    } catch {
      // error-policy:J3 malformed client JSON is an explicit invalid request.
    }
    const platform = body?.platform;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (
      platform !== "ios" ||
      !token ||
      token.length > MAX_MOBILE_PUSH_TOKEN_CHARACTERS
    ) {
      return json(
        c,
        { success: false, error: "Invalid mobile push registration" },
        400,
      );
    }
    await coordinateSharedPushRegister(
      r.agentId,
      { platform, token },
      { namespace: worker.namespace },
    );
    return json(c, { ok: true }, 201);
  }
  if (isWorkflowApiPath(path)) {
    return workflowUnavailable(c, r.agentId, r.agent.execution_tier);
  }
  // POST .../api/agent/start — the client's startup handshake.
  // A shared agent runs in-Worker with no agent server to boot, so the "start"
  // is a no-op that returns the running status the client expects.
  if (path === "agent/start") {
    return json(c, sharedRestAgentStart(r.agentName));
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
  if (c.req.method === "DELETE") {
    const path = shellPath(c);
    let token = pushTokenDeleteTarget(path);
    if (path === "notifications/push-tokens") {
      const contentLength = Number(c.req.header("content-length") ?? 0);
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_PUSH_REGISTRATION_BODY_BYTES
      ) {
        return json(
          c,
          { success: false, error: "Request body too large" },
          413,
        );
      }
      const rawBody = await c.req.text();
      if (
        new TextEncoder().encode(rawBody).length >
        MAX_PUSH_REGISTRATION_BODY_BYTES
      ) {
        return json(
          c,
          { success: false, error: "Request body too large" },
          413,
        );
      }
      let body: { token?: unknown } | null = null;
      try {
        body = JSON.parse(rawBody) as { token?: unknown };
      } catch {
        // error-policy:J3 malformed client JSON is an explicit invalid request.
      }
      token = typeof body?.token === "string" ? body.token.trim() : "";
    }
    if (token !== null) {
      if (!isPersonalSharedAgent(r)) return personalPushUnavailable(c);
      if (!token || token.length > MAX_MOBILE_PUSH_TOKEN_CHARACTERS)
        return json(
          c,
          { success: false, error: "Invalid mobile push token" },
          400,
        );
      const worker = resolveSharedRuntimeWorkerRequestContext(c);
      if ("error" in worker) return json(c, worker, worker.status);
      return json(c, {
        ok: await coordinateSharedPushUnregister(r.agentId, token, {
          namespace: worker.namespace,
        }),
      });
    }
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
