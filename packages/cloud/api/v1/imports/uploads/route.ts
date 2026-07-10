// Handles v1 conversation-import resumable upload session init (#13432).
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import type { AppEnv } from "@/types/cloud-worker-env";
import { importFailureResponse, initUploadSchema } from "../shared";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = initUploadSchema.parse(await c.req.json());
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    const result = await conversationImportsService.initResumableUpload(c.env, {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId: apiKeyId ?? null,
      source: body.source,
      filename: body.filename,
      contentType: body.contentType,
      uploadBytes: body.uploadBytes,
      chunkSize: body.chunkSize,
      declaredSha256: body.declaredSha256.toLowerCase(),
      ...(body.appId !== undefined && { appId: body.appId }),
      ...(body.conversationCount !== undefined && {
        conversationCount: body.conversationCount,
      }),
      ...(body.embeddingUnits !== undefined && {
        embeddingUnits: body.embeddingUnits,
      }),
      ...(body.retainRawUpload !== undefined && {
        retainRawUpload: body.retainRawUpload,
      }),
      ...(body.retainReason !== undefined && {
        retainReason: body.retainReason,
      }),
    });
    if (!result.ok) return importFailureResponse(c, result);
    return c.json(
      { success: true, session: result.session, batch: result.batch },
      201,
    );
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
