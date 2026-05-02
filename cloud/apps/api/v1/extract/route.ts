/**
 * POST /api/v1/extract
 * Extract content from a hosted browser page (HTML/links/markdown/screenshot).
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { extractHostedPage, logHostedBrowserFailure } from "@/lib/services/browser-tools";
import type { AppEnv } from "@/types/cloud-worker-env";

const extractRequestSchema = z.object({
  formats: z
    .array(z.enum(["html", "links", "markdown", "screenshot"]))
    .max(4)
    .optional(),
  onlyMainContent: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  url: z.string().trim().url().max(2_000),
  waitFor: z.number().int().min(0).max(120_000).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const bodyResult = extractRequestSchema.safeParse(await c.req.json());

    if (!bodyResult.success) {
      return c.json(
        {
          error: "Invalid extract request",
          details: bodyResult.error.flatten(),
        },
        400,
      );
    }

    const result = await extractHostedPage(bodyResult.data, {
      apiKeyId: null,
      organizationId: user.organization_id,
      requestSource: "api",
      userId: user.id,
    });

    return c.json(result);
  } catch (error) {
    logHostedBrowserFailure("extract_page", error);
    return failureResponse(c, error);
  }
});

export default app;
