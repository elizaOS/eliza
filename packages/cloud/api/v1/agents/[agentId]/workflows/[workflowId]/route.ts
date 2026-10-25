/**
 * Workflow proxy: GET / PUT / DELETE one workflow.
 *
 * GET    /api/v1/agents/:agentId/workflows/:workflowId  -> agent /api/workflow/workflows/:id
 * PUT    /api/v1/agents/:agentId/workflows/:workflowId  -> agent /api/workflow/workflows/:id
 * DELETE /api/v1/agents/:agentId/workflows/:workflowId  -> agent /api/workflow/workflows/:id
 *
 * Org-scoped ownership is enforced by elizaSandboxService.findRunningSandbox.
 * The agent authorizes the forwarded request via ELIZA_API_TOKEN Bearer.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  NotFoundError,
  ValidationError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { elizaSandboxService } from "@elizaos/cloud-shared/lib/services/eliza-sandbox";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

const WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function workflowIdOrThrow(c: {
  req: { param: (k: string) => string | undefined };
}): string {
  const workflowId = c.req.param("workflowId") ?? "";
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw ValidationError("Invalid workflow id");
  }
  return workflowId;
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";
    const workflowId = workflowIdOrThrow(c);

    const upstream = await elizaSandboxService.proxyWorkflowRequest(
      agentId,
      user.organization_id,
      `workflows/${workflowId}`,
      "GET",
    );

    if (!upstream) throw NotFoundError("Agent not found or not running");
    return upstream;
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";
    const workflowId = workflowIdOrThrow(c);

    const body = await c.req.text();
    const upstream = await elizaSandboxService.proxyWorkflowRequest(
      agentId,
      user.organization_id,
      `workflows/${workflowId}`,
      "PUT",
      body,
    );

    if (!upstream) throw NotFoundError("Agent not found or not running");
    return upstream;
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agentId = c.req.param("agentId") ?? "";
    const workflowId = workflowIdOrThrow(c);

    const upstream = await elizaSandboxService.proxyWorkflowRequest(
      agentId,
      user.organization_id,
      `workflows/${workflowId}`,
      "DELETE",
    );

    if (!upstream) throw NotFoundError("Agent not found or not running");
    return upstream;
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
