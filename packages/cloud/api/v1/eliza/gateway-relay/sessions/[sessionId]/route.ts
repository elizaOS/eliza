/**
 * DELETE /api/v1/eliza/gateway-relay/sessions/:sessionId
 *
 * Disconnects a relay session. Idempotent — succeeds even if the session
 * has already been collected.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { agentGatewayRelayService } from "@elizaos/cloud-shared/lib/services/agent-gateway-relay";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await agentGatewayRelayService.getSession(sessionId);

    if (session) {
      if (
        session.organizationId !== user.organization_id ||
        session.userId !== user.id
      ) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }
      await agentGatewayRelayService.disconnectSession(sessionId);
    }

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
