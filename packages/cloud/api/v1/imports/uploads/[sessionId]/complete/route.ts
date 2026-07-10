// Handles v1 conversation-import upload completion: whole-or-nothing, never a silent partial (#13432).
import { Hono } from "hono";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import type { AppEnv } from "@/types/cloud-worker-env";
import { importFailureResponse, sessionIdSchema } from "../../../shared";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = sessionIdSchema.parse(c.req.param("sessionId"));
    const result = await conversationImportsService.completeUpload(
      c.env,
      user.organization_id,
      sessionId,
    );
    if (!result) {
      return jsonError(
        c,
        404,
        "Upload session not found",
        "resource_not_found",
      );
    }
    if (!result.ok) return importFailureResponse(c, result);
    return c.json({
      success: true,
      batch: result.batch,
      artifact: result.artifact,
    });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
