/**
 * GET/POST /api/v1/browser/sessions
 * List/create hosted browser sessions for the authenticated org.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  createHostedBrowserSession,
  listHostedBrowserSessions,
  logHostedBrowserFailure,
} from "@/lib/services/browser-tools";
import type { AppEnv } from "@/types/cloud-worker-env";

const createSessionSchema = z.object({
  activityTtl: z.number().int().min(10).max(3600).optional(),
  show: z.boolean().optional(),
  title: z.string().trim().min(1).max(255).optional(),
  ttl: z.number().int().min(30).max(3600).optional(),
  url: z.string().trim().url().max(2_000).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessions = await listHostedBrowserSessions({
      apiKeyId: null,
      organizationId: user.organization_id,
      requestSource: "api",
      userId: user.id,
    });
    return c.json({ sessions });
  } catch (error) {
    logHostedBrowserFailure("browser_list", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const bodyResult = createSessionSchema.safeParse(await c.req.json());
    if (!bodyResult.success) {
      return c.json(
        {
          error: "Invalid browser session request",
          details: bodyResult.error.flatten(),
        },
        400,
      );
    }

    const session = await createHostedBrowserSession(bodyResult.data, {
      apiKeyId: null,
      organizationId: user.organization_id,
      requestSource: "api",
      userId: user.id,
    });
    return c.json({ session });
  } catch (error) {
    logHostedBrowserFailure("browser_create", error);
    return failureResponse(c, error);
  }
});

export default app;
