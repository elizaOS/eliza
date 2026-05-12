/**
 * Workflow proxy: get an execution status + result.
 *
 * GET /api/v1/agents/:agentId/workflows/executions/:executionId
 *   -> agent /api/workflow/executions/:id
 *
 * NOTE — agent-side gap: plugin-workflow's executions routes are defined
 * in src/routes/executions.ts but are NOT mounted in
 * src/plugin-routes.ts. This cloud route forwards anyway and will relay
 * whatever the agent returns (currently 404). Once the plugin mounts the
 * executions surface, this endpoint becomes live with no cloud changes.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const EXECUTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";
    const executionId = c.req.param("executionId") ?? "";
    if (!EXECUTION_ID_PATTERN.test(executionId)) {
      throw ValidationError("Invalid execution id");
    }

    const upstream = await elizaSandboxService.proxyWorkflowRequest(
      agentId,
      user.organization_id,
      `executions/${executionId}`,
      "GET",
    );

    if (!upstream) throw NotFoundError("Agent not found or not running");
    return upstream;
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
