// Handles v1 conversation-import batch listing scoped to the authenticated organization (#13432).
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const query = listQuerySchema.parse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    const result = await conversationImportsService.listBatches(
      user.organization_id,
      query,
    );
    return c.json({
      success: true,
      batches: result.items,
      pagination: {
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        nextOffset: result.hasMore ? result.offset + result.limit : null,
      },
    });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
