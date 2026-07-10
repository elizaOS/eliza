// Handles v1 conversation-import resumable session status (resume support) and abort (#13432).
import { Hono } from "hono";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import type { AppEnv } from "@/types/cloud-worker-env";
import { sessionIdSchema } from "../../shared";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = sessionIdSchema.parse(c.req.param("sessionId"));
    const session = await conversationImportsService.getUploadStatus(
      user.organization_id,
      sessionId,
    );
    if (!session) {
      return jsonError(
        c,
        404,
        "Upload session not found",
        "resource_not_found",
      );
    }
    return c.json({ success: true, session });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = sessionIdSchema.parse(c.req.param("sessionId"));
    const result = await conversationImportsService.abortUpload(
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
    return c.json({
      success: true,
      sessionId: result.sessionId,
      status: result.status,
    });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
