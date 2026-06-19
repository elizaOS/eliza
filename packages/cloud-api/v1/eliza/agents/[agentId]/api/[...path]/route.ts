import { type Context, Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { resolveSharedAgent } from "@/lib/services/shared-runtime/resolve-shared-agent";
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

/**
 * Catch-all shell-endpoint adapter for a SHARED-runtime agent's REST surface.
 *
 * `/api/v1/eliza/agents/[agentId]/api/[...path]`
 *
 * A Tier-0 shared agent runs in-Worker with NO agent server, so it serves none
 * of the shell endpoints the mobile/web startup-coordinator probes after
 * conversations/messages already 200: GET /api/first-run/status, GET
 * /api/first-run, GET /api/views, GET /api/config. Without them every probe
 * 404s and the app never boots into chat (see app-side #8529). This leaf
 * synthesizes the "already-provisioned, no setup needed" defaults so the app
 * boots straight into chat regardless of which shell endpoint it probes next.
 *
 * CODEGEN PRECEDENCE: this file maps to the splat path
 * `/api/v1/eliza/agents/:agentId/api/:*{.+}` (segmentRank 2), which the router
 * codegen (_generate-router.mjs `compareMountPaths`) sorts AFTER every static
 * sibling leaf (conversations, conversations/:id/messages, health, identity*,
 * wallet/:*). Hono is mount-order-sensitive for overlapping splat-vs-specific
 * sub-apps, so those specific leaves win and this catch-all only handles the
 * shell paths they don't serve. It is intentionally SCOPED to the known shell
 * paths and 404s anything else, so it never masks a genuinely-missing route.
 *
 * Scoped to shared-tier agents owned by the caller's org; dedicated agents use
 * their own subdomain REST surface, not this adapter.
 */
const CORS_METHODS = "GET, POST, OPTIONS";

const app = new Hono<AppEnv>();

function json(data: unknown, status?: number): Response {
  return applyCorsHeaders(
    status ? Response.json(data, { status }) : Response.json(data),
    CORS_METHODS,
  );
}

/** Normalize the splat into a clean "/"-joined shell path (no query/trailing). */
function shellPath(c: Context<AppEnv>): string {
  const raw = c.req.param("*") ?? "";
  return raw
    .split("/")
    .filter((s) => s.length > 0)
    .join("/");
}

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return json({ success: false, error: r.error }, r.status);
  }
  switch (shellPath(c)) {
    case "status":
      // The startup-coordinator's first gate — must answer before first-run.
      return json(sharedRestStatus(r.agentName));
    case "first-run/status":
      return json(sharedRestFirstRunStatus());
    case "first-run":
      return json(sharedRestFirstRun());
    case "views":
      return json(sharedRestViews(c.req.query("viewType")));
    case "config":
      return json(sharedRestConfig());
    case "auth/me":
      // The app's hard startup auth gate. The caller is already an authed API
      // key (resolveSharedAgent validated it), so report the authed machine
      // identity instead of 404'ing into "server_unavailable".
      return json(sharedRestAuthMe(r.agentId, r.agentName));
    case "character":
      // The exact character the shared turn answers as (reuses
      // buildSharedRuntimeCharacter via the service).
      return json(await sharedRestCharacter(r.agentId, r.orgId, r.agentName));
    default:
      // Genuinely-unknown shell endpoint — don't mask it with a default.
      return json(
        { success: false, error: "Not found", code: "resource_not_found" },
        404,
      );
  }
});

app.post("/", async (c) => {
  const r = await resolveSharedAgent(c);
  if ("error" in r) {
    return json({ success: false, error: r.error }, r.status);
  }
  // Onboarding "submit" — a shared agent has no config to persist, so accept it
  // as a harmless no-op instead of 404'ing onboarding.
  if (shellPath(c) === "first-run") {
    return json(sharedRestFirstRunSubmit());
  }
  return json(
    { success: false, error: "Not found", code: "resource_not_found" },
    404,
  );
});

export default app;
