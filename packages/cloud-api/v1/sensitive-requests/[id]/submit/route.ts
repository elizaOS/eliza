/**
 * Authenticated sensitive request submit endpoint.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  type SensitiveRequestActor,
  sensitiveRequestsService,
} from "@/lib/services/sensitive-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const SubmitSensitiveRequestSchema = z.object({
  token: z.string().trim().min(1).optional(),
  value: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
});

function actorFromUser(
  user: Awaited<ReturnType<typeof requireUserOrApiKeyWithOrg>>,
): SensitiveRequestActor {
  return {
    type: "user",
    userId: user.id,
    organizationId: user.organization_id,
    email: user.email,
  };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ success: false, error: "Missing request id" }, 400);

    const body = await c.req.json().catch(() => null);
    const parsed = SubmitSensitiveRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const request = await sensitiveRequestsService.submit({
      id,
      actor: actorFromUser(user),
      ...parsed.data,
    });

    return c.json({ success: true, request });
  } catch (error) {
    logger.error("[SensitiveRequests API] submit failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
