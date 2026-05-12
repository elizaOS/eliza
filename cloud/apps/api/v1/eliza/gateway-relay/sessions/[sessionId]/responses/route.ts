/**
 * POST /api/v1/eliza/gateway-relay/sessions/:sessionId/responses
 *
 * Submits a JSON-RPC response envelope back through the relay for a previously
 * polled bridge request.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { agentGatewayRelayService } from "@/lib/services/agent-gateway-relay";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const bridgeResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

const respondSchema = z.object({
  requestId: z.string().trim().min(1),
  response: bridgeResponseSchema,
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await agentGatewayRelayService.getSession(sessionId);

    if (!session) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }

    if (session.organizationId !== user.organization_id || session.userId !== user.id) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = respondSchema.safeParse(body);
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

    const accepted = await agentGatewayRelayService.respondToRequest({
      sessionId,
      requestId: parsed.data.requestId,
      response: parsed.data.response,
    });

    if (!accepted) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
