/**
 * POST /api/v1/x/dms/send
 * Send an X DM to a single participant. Requires explicit confirmSend.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { sendXDm } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../../error-response";

const requestSchema = z.object({
  confirmSend: z.literal(true),
  connectionRole: z.enum(["owner", "agent"]).optional(),
  participantId: z.string().trim().regex(/^\d+$/),
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
          error: "Invalid X DM send request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const result = await sendXDm({
      organizationId: user.organization_id,
      connectionRole: parsed.data.connectionRole,
      participantId: parsed.data.participantId,
      text: parsed.data.text,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
