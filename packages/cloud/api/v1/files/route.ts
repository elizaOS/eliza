// Handles v1 cloud API v1 files route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import {
  ApiError,
  failureResponse,
  jsonError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  CloudFileQuotaExceededError,
  cloudFilesService,
} from "@/lib/services/cloud-files";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  source: z.string().trim().min(1).max(32).optional(),
  kind: z.string().trim().min(1).max(32).optional(),
  mimeType: z.string().trim().min(1).max(128).optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

function parseMetadata(
  value: FormDataEntryValue | null,
): Record<string, unknown> {
  if (value == null || value === "") return {};
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "validation_error",
      "metadata must be a JSON object string",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ApiError(400, "validation_error", "metadata must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(
      400,
      "validation_error",
      "metadata must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function toClientFile(file: Awaited<ReturnType<typeof cloudFilesService.get>>) {
  if (!file) return null;
  return {
    id: file.id,
    source: file.source,
    kind: file.kind,
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: Number(file.size_bytes),
    sha256: file.sha256,
    url: file.storage_url,
    generationId: file.generation_id,
    metadata: file.metadata,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
  };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = listQuerySchema.parse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      source: c.req.query("source"),
      kind: c.req.query("kind"),
      mimeType: c.req.query("mimeType"),
      q: c.req.query("q"),
    });
    const { q, ...filters } = parsed;
    const result = await cloudFilesService.list({
      organizationId: user.organization_id,
      ...filters,
      search: q,
    });
    return c.json({
      success: true,
      files: result.items.map(toClientFile),
      pagination: {
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        nextOffset: result.hasMore ? result.offset + result.limit : null,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (!c.env.BLOB) {
      return jsonError(
        c,
        503,
        "R2 storage is not configured",
        "internal_error",
      );
    }

    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return c.json(
        { success: false, error: "multipart/form-data is required" },
        400,
      );
    }

    const files = form
      .getAll("files")
      .concat(form.getAll("file"))
      .filter((value): value is File => value instanceof File);
    if (files.length === 0) {
      return c.json(
        { success: false, error: "At least one file is required" },
        400,
      );
    }
    if (files.length > MAX_UPLOAD_FILES) {
      return c.json(
        {
          success: false,
          error: `Too many files in one request; maximum is ${MAX_UPLOAD_FILES}`,
        },
        413,
      );
    }
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json(
          {
            success: false,
            error: `File ${file.name || "upload"} exceeds ${MAX_UPLOAD_BYTES} bytes`,
          },
          413,
        );
      }
    }

    const metadata = parseMetadata(form.get("metadata"));
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    const uploaded: Array<
      Awaited<ReturnType<typeof cloudFilesService.upload>>
    > = [];
    for (const file of files) {
      try {
        uploaded.push(
          await cloudFilesService.upload(c.env, {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId,
            file,
            metadata,
          }),
        );
      } catch (error) {
        for (let index = uploaded.length - 1; index >= 0; index -= 1) {
          const uploadedFile = uploaded[index];
          await cloudFilesService
            .delete(c.env, user.organization_id, uploadedFile.id)
            .catch((deleteError) => {
              logger.warn(
                "[CloudFiles API] Failed to roll back multipart upload after failure",
                {
                  organizationId: user.organization_id,
                  fileId: uploadedFile.id,
                  error:
                    deleteError instanceof Error
                      ? deleteError.message
                      : String(deleteError),
                },
              );
            });
        }
        if (error instanceof CloudFileQuotaExceededError) {
          return c.json({ success: false, error: error.message }, 413);
        }
        throw error;
      }
    }

    logger.info("[CloudFiles API] Uploaded files", {
      organizationId: user.organization_id,
      count: uploaded.length,
    });

    return c.json(
      {
        success: true,
        files: uploaded.map(toClientFile),
      },
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
