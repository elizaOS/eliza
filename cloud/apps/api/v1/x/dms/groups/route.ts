/**
 * POST /api/v1/x/dms/groups
 * Create a group X DM with a confirmed list of participant IDs.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { createXDmGroup } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../../error-response";

const requestSchema = z.object({
  confirmSend: z.literal(true),
  connectionRole: z.enum(["owner", "agent"]).optional(),
  participantIds: z.array(z.string().trim().regex(/^\d+$/)).min(2),
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
          error: "Invalid X group DM request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const result = await createXDmGroup({
      organizationId: user.organization_id,
      connectionRole: parsed.data.connectionRole,
      participantIds: parsed.data.participantIds,
      text: parsed.data.text,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
