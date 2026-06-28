/**
 * Workflow proxy: list + create.
 *
 * GET  /api/v1/agents/:agentId/workflows         -> agent /api/workflow/workflows
 * POST /api/v1/agents/:agentId/workflows         -> agent /api/workflow/workflows
 *
 * Auth: user JWT or API key with org. The agent (Railway, on the user's
 * sandbox) is identified via elizaSandboxService and ownership is enforced
 * by org scope: findRunningSandbox(agentId, orgId) returns null if the
 * agent does not belong to the caller's organization.
 *
 * The agent itself authenticates the forwarded request via the
 * `ELIZA_API_TOKEN` Bearer header attached inside proxyWorkflowRequest.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const url = new URL(c.req.url);
    const upstream = await elizaSandboxService.proxyWorkflowRequest(
      agentId,
      user.organization_id,
      "workflows",
      "GET",
      null,
      url.search.replace(/^\?/, ""),
    );

    if (!upstream) throw NotFoundError("Agent not found or not running");
    return upstream;
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";

    const body = await c.req.text();
    const upstream = await elizaSandboxService.proxyWorkflowRequest(
      agentId,
      user.organization_id,
      "workflows",
      "POST",
      body,
    );

    if (!upstream) throw NotFoundError("Agent not found or not running");
    return upstream;
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
