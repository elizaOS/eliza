/**
 * Approval requests — single resource (Wave D).
 *
 * GET  /api/v1/approval-requests/:id            Authed creator view (full row).
 * GET  /api/v1/approval-requests/:id?public=1   Redacted public view (no auth):
 *                                               strips signatureText so an
 *                                               unauthenticated signer can read
 *                                               the challenge before signing.
 */

import { Hono } from "hono";
import { approvalRequestsRepository } from "@/db/repositories/approval-requests";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  type ApprovalRequestsService,
  createApprovalRequestsService,
  redactApprovalRequestForPublic,
} from "@/lib/services/approval-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parseApprovalRequestIdParam } from "../approval-request-id";

let singleton: ApprovalRequestsService | null = null;
function getApprovalRequestsService(): ApprovalRequestsService {
  singleton ??= createApprovalRequestsService({
    repository: approvalRequestsRepository,
  });
  return singleton;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const parsedId = parseApprovalRequestIdParam(c.req.param("id"));
    if (!parsedId.ok) {
      return c.json({ success: false, error: parsedId.error }, 400);
    }
    const { id } = parsedId;
    // The public view is an unauthenticated security boundary, so ambiguous
    // duplicates and every token other than the documented empty/`1` forms
    // must fail before authentication or lookup.
    const requestedPublicValues = c.req.queries("public");
    const requestedPublic = requestedPublicValues?.[0];
    if (
      requestedPublicValues !== undefined &&
      (requestedPublicValues.length !== 1 ||
        (requestedPublic !== "" && requestedPublic !== "1"))
    ) {
      return c.json(
        {
          success: false,
          error: "invalid_public",
          message: 'public must be "1" for the redacted approval view.',
        },
        400,
      );
    }
    const isPublic = requestedPublic === "1";
    const service = getApprovalRequestsService();

    if (isPublic) {
      const row = await service.getPublic(id);
      if (!row) {
        return c.json(
          { success: false, error: "Approval request not found" },
          404,
        );
      }
      return c.json({
        success: true,
        approvalRequest: redactApprovalRequestForPublic(row),
      });
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const row = await service.get(id, user.organization_id);
    if (!row) {
      return c.json(
        { success: false, error: "Approval request not found" },
        404,
      );
    }

    return c.json({ success: true, approvalRequest: row });
  } catch (error) {
    // error-policy:J1 boundary translation — failureResponse maps typed/unknown
    // errors to structured JSON. Prefer message/code over `{ name: "Error" }`
    // so Worker tails surface the Postgres cause instead of an empty shell.
    logger.error("[ApprovalRequests API] Failed to get approval request", {
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              code:
                "code" in error && typeof error.code === "string"
                  ? error.code
                  : undefined,
            }
          : { message: String(error) },
    });
    return failureResponse(c, error);
  }
});

export default app;
