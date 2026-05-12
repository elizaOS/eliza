/**
 * POST /api/v1/x/dms/curate
 * Curate (filter / rank) X DMs for the authenticated org. Optional body
 * narrows by connectionRole and result count.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { curateXDms } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../../error-response";

const requestSchema = z
  .object({
    connectionRole: z.enum(["owner", "agent"]).optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .optional();

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: unknown;
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ success: false, error: "Request body must be valid JSON" }, 400);
      }
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid X DM curate request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const result = await curateXDms({
      organizationId: user.organization_id,
      connectionRole: parsed.data?.connectionRole,
      maxResults: parsed.data?.maxResults,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
