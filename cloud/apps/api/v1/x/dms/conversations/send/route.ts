/**
 * POST /api/v1/x/dms/conversations/send
 * Send an X DM into an existing conversation by conversationId. Requires
 * explicit confirmSend.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { sendXDmToConversation } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../../../error-response";

const requestSchema = z.object({
  confirmSend: z.literal(true),
  connectionRole: z.enum(["owner", "agent"]).optional(),
  conversationId: z.string().trim().regex(/^\d+$/),
  text: z.string().trim().min(1).max(10_000),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Request body must be valid JSON" }, 400);
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid X conversation DM request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const result = await sendXDmToConversation({
      organizationId: user.organization_id,
      connectionRole: parsed.data.connectionRole,
      conversationId: parsed.data.conversationId,
      text: parsed.data.text,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
