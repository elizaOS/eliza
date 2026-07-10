// Handles v1 conversation-import chunk upload: validated, idempotent, resumable (#13432).
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { conversationImportsService } from "@/lib/services/conversation-imports";
import type { AppEnv } from "@/types/cloud-worker-env";
import { importFailureResponse, sessionIdSchema } from "../../../../shared";

const app = new Hono<AppEnv>();

// Chunk PUTs arrive in bursts: a 1 GiB import at the recommended 16 MiB chunk
// size is 64 requests, so the standard 60/min preset would starve it.
app.use("*", rateLimit(RateLimitPresets.RELAXED));

const chunkIndexSchema = z.coerce.number().int().nonnegative();
const offsetSchema = z.coerce.number().int().nonnegative();
const chunkSha256Schema = z
  .string()
  .trim()
  .regex(/^[A-Fa-f0-9]{64}$/, "must be a hex sha256 digest");

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = sessionIdSchema.parse(c.req.param("sessionId"));
    const chunkIndex = chunkIndexSchema.parse(c.req.param("chunkIndex"));
    const offsetHeader = c.req.header("x-import-chunk-offset");
    if (offsetHeader === undefined) {
      return jsonError(
        c,
        400,
        "x-import-chunk-offset header is required",
        "validation_error",
      );
    }
    const offset = offsetSchema.parse(offsetHeader);
    const sha256Header = c.req.header("x-import-chunk-sha256");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) {
      return jsonError(
        c,
        400,
        "chunk body must not be empty",
        "validation_error",
      );
    }
    const result = await conversationImportsService.appendChunk(c.env, {
      organizationId: user.organization_id,
      sessionId,
      chunkIndex,
      offset,
      bytes,
      ...(sha256Header !== undefined && {
        sha256: chunkSha256Schema.parse(sha256Header).toLowerCase(),
      }),
    });
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
      status: result.status,
      chunkIndex: result.chunkIndex,
      progress: result.progress,
    });
  } catch (error) {
    // error-policy: route boundary — thrown errors become structured HTTP failures.
    return failureResponse(c, error);
  }
});

export default app;
