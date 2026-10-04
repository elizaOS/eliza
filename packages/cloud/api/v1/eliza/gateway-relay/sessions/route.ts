/**
 * POST /api/v1/eliza/gateway-relay/sessions
 *
 * Registers a long-poll relay session for a runtime agent. Returns the
 * session record the runtime should use to poll for and respond to bridge
 * requests.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { agentGatewayRelayService } from "@elizaos/cloud-shared/lib/services/agent-gateway-relay";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const registerSessionSchema = z.object({
  runtimeAgentId: z.string().trim().min(1).max(200),
  agentName: z.string().trim().max(200).optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = registerSessionSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const session = await agentGatewayRelayService.registerSession({
      organizationId: user.organization_id,
      userId: user.id,
      runtimeAgentId: parsed.data.runtimeAgentId,
      agentName: parsed.data.agentName,
    });

    return c.json({ success: true, data: { session } });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
