/**
 * GET /api/v1/connections/accounts/:accountId — detail view for one opaque
 * connected-account handle inside the authenticated organization. Handles are
 * resolved only within the caller's org projection, so a handle minted for a
 * different organization returns 404 rather than leaking existence.
 */

import { Hono } from "hono";
import {
  failureResponse,
  ApiError as WorkerApiError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { connectedCapabilitiesService } from "@/lib/services/connected-capabilities";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const ACCOUNT_ID_PATTERN = /^ca_[0-9a-f]{32}$/;

app.get("/", async (c) => {
  const accountId = c.req.param("accountId");
  if (accountId === undefined || !ACCOUNT_ID_PATTERN.test(accountId)) {
    return c.json(
      {
        error: "INVALID_ACCOUNT_ID",
        message: "accountId must be an opaque connected-account handle",
      },
      400,
    );
  }

  let organizationId: string | undefined;
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    organizationId = user.organization_id;

    const account = await connectedCapabilitiesService.get(
      organizationId,
      accountId,
    );
    if (account === null) {
      return c.json(
        {
          error: "CONNECTED_ACCOUNT_NOT_FOUND",
          message: "No connected account matches this handle",
        },
        404,
      );
    }
    return c.json({ account });
  } catch (error) {
    // error-policy:J1 route boundary translates auth/projection failures into
    // structured responses without exposing storage or token context.
    logger.error("[API] GET /api/v1/connections/accounts/:accountId error", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof WorkerApiError) {
      return failureResponse(c, error);
    }
    return c.json(
      {
        error: "CONNECTED_ACCOUNTS_UNAVAILABLE",
        message: "Failed to load connected account",
      },
      500,
    );
  }
});

export default app;
