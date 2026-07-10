// Handles v1 conversation-import preflight: quota/size admission before any bytes are accepted (#13432).
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import type { AppEnv } from "@/types/cloud-worker-env";
import { importFailureResponse, usageEstimateSchema } from "../shared";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = usageEstimateSchema.parse(await c.req.json());
    const decision = await conversationImportsService.preflight(c.env, {
      organizationId: user.organization_id,
      uploadBytes: body.uploadBytes,
      ...(body.conversationCount !== undefined && {
        conversationCount: body.conversationCount,
      }),
      ...(body.storageBytes !== undefined && {
        storageBytes: body.storageBytes,
      }),
      ...(body.embeddingUnits !== undefined && {
        embeddingUnits: body.embeddingUnits,
      }),
    });
    if (!decision.ok) return importFailureResponse(c, decision);
    return c.json({ success: true, decision });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
