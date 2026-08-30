/** Recovery-capability boundary for building and downloading the portable export. */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { checkElizaMutatingRequestOrigin } from "@/lib/auth/browser-origin-policy";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  AccountDeletionExportError,
  getAccountDeletionExport,
} from "@/lib/services/account-deletion-export";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use(
  "*",
  rateLimit({
    ...RateLimitPresets.CRITICAL,
    failClosed: true,
    localLease: false,
  }),
);

app.post("/", async (c) => {
  c.header("Cache-Control", "no-store, private");
  const origin = checkElizaMutatingRequestOrigin(
    c.req,
    c.env.NODE_ENV === "production",
  );
  if (!origin.ok) {
    return c.json(
      { error: "Forbidden", code: "forbidden_origin" as const },
      403,
    );
  }
  const recoveryCredential =
    c.req.header("X-Account-Deletion-Recovery")?.trim() ?? "";
  let body: { confirmation?: unknown };
  try {
    body = await c.req.json<{ confirmation?: unknown }>();
  } catch {
    // error-policy:J3 malformed JSON is an invalid confirmation, never a
    // fabricated valid deletion-export request.
    body = {};
  }
  if (body.confirmation !== "EXPORT MY DATA") {
    return c.json(
      {
        error: "Type EXPORT MY DATA to build the recovery export",
        code: "CONFIRMATION_REQUIRED" as const,
      },
      400,
    );
  }

  try {
    const download = await getAccountDeletionExport(recoveryCredential);
    const responseBody = download.bytes.buffer.slice(
      download.bytes.byteOffset,
      download.bytes.byteOffset + download.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(responseBody, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Disposition": `attachment; filename="${download.filename}"`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Account-Deletion-Export-SHA256": download.contentDigest,
      },
    });
  } catch (error) {
    // error-policy:J1 translate typed service failures at the HTTP boundary.
    if (error instanceof AccountDeletionExportError) {
      const status =
        error.code === "EXPORT_CREDENTIAL_INVALID"
          ? 401
          : error.code === "EXPORT_BUSY"
            ? 409
            : error.code === "EXPORT_TOO_LARGE"
              ? 413
              : 410;
      return c.json({ error: error.message, code: error.code }, status);
    }
    return failureResponse(c, error);
  }
});

export default app;
