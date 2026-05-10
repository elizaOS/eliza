/**
 * Workflow proxy: trigger a workflow execution.
 *
 * POST /api/v1/agents/:agentId/workflows/:workflowId/run
 *   -> agent /api/workflow/workflows/:id/run
 *
 * NOTE — agent-side gap: as of writing, plugin-workflow's mounted route
 * surface (plugins/plugin-workflow/src/plugin-routes.ts) does NOT include
 * a `:id/run` endpoint. The closest mounted endpoints are
 * `:id/activate` and `:id/deactivate`. This cloud route forwards to
 * `/api/workflow/workflows/:id/run` and will relay whatever the agent
 * returns (currently 404). Once the plugin mounts a run/trigger handler,
 * this endpoint becomes live with no cloud changes required.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";
    const workflowId = c.req.param("workflowId") ?? "";
    if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
      throw ValidationError("Invalid workflow id");
    }

    const body = await c.req.text();
    const upstream = await elizaSandboxService.proxyWorkflowRequest(
      agentId,
      user.organization_id,
      `workflows/${workflowId}/run`,
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
