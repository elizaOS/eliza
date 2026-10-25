/**
 * POST /api/v1/me/data-export
 *
 * Live-account portable data export for the signed-in user. Reuses the
 * account-deletion export collector/serializer (same artifact and response
 * shape as `/api/public/account-deletion/export`) without opening a deletion
 * request. Oversized accounts get an explicit 413 `EXPORT_TOO_LARGE`; nothing
 * is truncated. Each successful export writes a `data.export` audit record.
 */

import { createHash, randomUUID } from "node:crypto";
import { requireRecentSessionUserWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { checkElizaMutatingRequestOrigin } from "@elizaos/cloud-shared/lib/auth/browser-origin-policy";
import {
  getRequestIp,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  AccountDeletionExportError,
  collectPortableAccountDeletionExport,
} from "@elizaos/cloud-shared/lib/services/account-deletion-export";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";

interface DataExportDependencies {
  collect: typeof collectPortableAccountDeletionExport;
}

export function createDataExportRoute(
  overrides: Partial<DataExportDependencies> = {},
) {
  const dependencies: DataExportDependencies = {
    collect: collectPortableAccountDeletionExport,
    ...overrides,
  };
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
    try {
      // Same bar as the deletion export: a freshly authenticated browser
      // session, never an API key or bridge session.
      const user = await requireRecentSessionUserWithOrg(c);
      const requestId = randomUUID();
      const bytes = await dependencies.collect({
        requestId,
        userId: user.id,
        organizationId: user.organization_id,
        generatedAt: new Date(),
        // Other members' rows in a shared organization are not this user's data.
        subjectScope: "user",
      });
      // The export is only released once its access is durably audited.
      await getAuditDispatcher().emit({
        actor: { type: "user", id: user.id },
        action: "data.export",
        result: "success",
        resource: { type: "account_export", id: requestId },
        org_id: user.organization_id,
        ip: getRequestIp(c),
        user_agent: c.req.header("user-agent") ?? undefined,
        request_id: c.get("requestId"),
        metadata: {
          request_id: requestId,
          scope: "live_account",
          bytes: bytes.byteLength,
        },
      });
      const responseBody = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      return new Response(responseBody, {
        status: 200,
        headers: {
          "Cache-Control": "no-store, private",
          "Content-Disposition":
            'attachment; filename="eliza-account-export.json"',
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Account-Deletion-Export-SHA256": createHash("sha256")
            .update(bytes)
            .digest("hex"),
        },
      });
    } catch (error) {
      // error-policy:J1 translate typed service failures at the HTTP boundary.
      if (
        error instanceof AccountDeletionExportError &&
        error.code === "EXPORT_TOO_LARGE"
      ) {
        return c.json({ error: error.message, code: error.code }, 413);
      }
      return failureResponse(c, error);
    }
  });
  return app;
}

export default createDataExportRoute();
