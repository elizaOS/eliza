// Handles v1 conversation-import direct (small) uploads within the conservative ceiling (#13432).
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
import { importFailureResponse } from "../../shared";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

const fieldsSchema = z.object({
  source: z.string().trim().min(1).max(64),
  appId: z.string().trim().min(1).max(128).optional(),
  conversationCount: z.coerce.number().int().nonnegative().optional(),
  embeddingUnits: z.coerce.number().int().nonnegative().optional(),
  retainRawUpload: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  retainReason: z.string().trim().min(1).max(500).optional(),
});

function formString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return c.json(
        { success: false, error: "multipart/form-data is required" },
        400,
      );
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json(
        { success: false, error: "A single file field is required" },
        400,
      );
    }
    const fields = fieldsSchema.parse({
      source: formString(form.get("source")),
      appId: formString(form.get("appId")),
      conversationCount: formString(form.get("conversationCount")),
      embeddingUnits: formString(form.get("embeddingUnits")),
      retainRawUpload: formString(form.get("retainRawUpload")),
      retainReason: formString(form.get("retainReason")),
    });
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    const result = await conversationImportsService.directUpload(c.env, {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId: apiKeyId ?? null,
      source: fields.source,
      filename: file.name || "upload",
      contentType: file.type || "application/octet-stream",
      bytes: new Uint8Array(await file.arrayBuffer()),
      ...(fields.appId !== undefined && { appId: fields.appId }),
      ...(fields.conversationCount !== undefined && {
        conversationCount: fields.conversationCount,
      }),
      ...(fields.embeddingUnits !== undefined && {
        embeddingUnits: fields.embeddingUnits,
      }),
      ...(fields.retainRawUpload !== undefined && {
        retainRawUpload: fields.retainRawUpload,
      }),
      ...(fields.retainReason !== undefined && {
        retainReason: fields.retainReason,
      }),
    });
    if (!result.ok) return importFailureResponse(c, result);
    return c.json(
      { success: true, batch: result.batch, artifact: result.artifact },
      201,
    );
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
