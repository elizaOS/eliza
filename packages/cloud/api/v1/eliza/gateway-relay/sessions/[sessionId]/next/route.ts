/**
 * GET /api/v1/eliza/gateway-relay/sessions/:sessionId/next
 *
 * Long-poll for the next bridge request envelope on this relay session.
 * Caps the wait at 25s so platform-level edge timeouts can never strand a
 * client waiting on a closed connection.
 */

import { parsePositiveInteger } from "@elizaos/shared/utils/number-parsing";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { agentGatewayRelayService } from "@/lib/services/agent-gateway-relay";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const MAX_TIMEOUT_MS = 25_000;

function parseTimeoutMs(raw: string | undefined): number {
  const parsed = parsePositiveInteger(raw, MAX_TIMEOUT_MS);
  if (parsed === undefined) return MAX_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await agentGatewayRelayService.getSession(sessionId);

    if (!session) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }

    if (
      session.organizationId !== user.organization_id ||
      session.userId !== user.id
    ) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const requestEnvelope = await agentGatewayRelayService.pollNextRequest(
      sessionId,
      parseTimeoutMs(c.req.query("timeoutMs")),
    );

    return c.json({
      success: true,
      data: { request: requestEnvelope },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
