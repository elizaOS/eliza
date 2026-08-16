/**
 * GET /api/v1/eliza/gateway-relay/sessions/:sessionId/next
 *
 * Long-poll for the next bridge request envelope on this relay session.
 * Accepts only canonical millisecond values through 25s so platform-level
 * edge timeouts can never strand a client waiting on a closed connection.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { agentGatewayRelayService } from "@/lib/services/agent-gateway-relay";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function parseTimeoutMs(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return 25_000;
  }

  if (!/^[1-9][0-9]*$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);
  return parsed <= 25_000 ? parsed : null;
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

    const timeoutMs = parseTimeoutMs(c.req.query("timeoutMs"));
    if (timeoutMs === null) {
      return c.json(
        {
          success: false,
          error: "timeoutMs must be a canonical integer from 1 to 25000",
        },
        400,
      );
    }

    const requestEnvelope = await agentGatewayRelayService.pollNextRequest(
      sessionId,
      timeoutMs,
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
