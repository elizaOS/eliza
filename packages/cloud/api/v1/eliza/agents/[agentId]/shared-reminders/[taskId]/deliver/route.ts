/**
 * Relays a committed Shared reminder for its authenticated Dedicated target.
 * Delivery data is re-read from the source-owned cutover row, never accepted
 * from the container request.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { sharedReminderDispatcher } from "@/lib/services/shared-runtime/shared-reminder-cron";
import { readCommittedSharedReminderForTarget } from "@/lib/services/shared-runtime/shared-scheduling";
import type { AppEnv } from "@/types/cloud-worker-env";

const bodySchema = z.object({ firedAtIso: z.string().datetime() });
const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const { user } = await requireAuthOrApiKeyWithOrg(c.req.raw);
  const targetAgentId = c.req.param("agentId");
  const taskId = c.req.param("taskId");
  if (!targetAgentId || !taskId) {
    return c.json(
      { success: false, error: "Agent and reminder are required" },
      400,
    );
  }
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { success: false, error: "A valid firedAtIso is required." },
      400,
    );
  }
  const target = await elizaSandboxService.getAgent(
    targetAgentId,
    user.organization_id,
  );
  if (!target) {
    return c.json({ success: false, error: "Agent not found" }, 404);
  }
  const task = await readCommittedSharedReminderForTarget({
    targetAgentId,
    taskId,
  });
  if (!task) {
    return c.json(
      { success: false, error: "Committed reminder not found" },
      404,
    );
  }

  const result = await sharedReminderDispatcher(c.env).dispatch({
    taskId: task.taskId,
    kind: task.kind,
    firedAtIso: parsed.data.firedAtIso,
    channelKey: "current_dm",
    promptInstructions: task.promptInstructions,
    ownerVisible: task.ownerVisible,
    contextRequest: task.contextRequest,
    ...(task.output ? { output: task.output } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
  });
  if (result?.ok === false) {
    return c.json(
      {
        success: false,
        reason: result.reason,
        acceptance: result.acceptance ?? "unknown",
        retryAfterMinutes: result.retryAfterMinutes,
      },
      result.acceptance === "unknown" ? 202 : 409,
    );
  }
  return c.json({
    success: true,
    messageId: result?.messageId,
    metadata: result?.metadata,
  });
});

export default app;
