// Handles v1 conversation-import batch inspection and retention-policy batch delete (#13432).
import { Hono } from "hono";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import type { AppEnv } from "@/types/cloud-worker-env";
import { batchIdSchema } from "../../shared";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const batchId = batchIdSchema.parse(c.req.param("batchId"));
    const result = await conversationImportsService.getBatch(
      user.organization_id,
      batchId,
    );
    if (!result) {
      return jsonError(c, 404, "Import batch not found", "resource_not_found");
    }
    return c.json({
      success: true,
      batch: result.batch,
      artifacts: result.artifacts,
    });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const batchId = batchIdSchema.parse(c.req.param("batchId"));
    const report = await conversationImportsService.deleteBatch(
      c.env,
      user.organization_id,
      batchId,
    );
    if (!report) {
      return jsonError(c, 404, "Import batch not found", "resource_not_found");
    }
    // 200 with per-artifact accounting even when some deletions failed: the
    // report is the DTO the retry UX consumes; nothing is hidden as success.
    return c.json({ success: report.failed.length === 0, report });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
