/**
 * GET /api/v1/connections/accounts — org-scoped list of every managed
 * connection (cloud OAuth, vendor, connector, native device) projected into
 * the shared `ConnectedAccount` capability DTO. Supports offset pagination and
 * fail-closed `providerId` / `mode` filters. No secret material is reachable:
 * the projection layer never reads token or ciphertext columns into the DTO.
 */

import { Hono } from "hono";
import {
  failureResponse,
  ApiError as WorkerApiError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  CONNECTED_ACCOUNT_MODES,
  type ConnectedAccountMode,
  connectedCapabilitiesService,
} from "@/lib/services/connected-capabilities";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parsePaginationParam } from "../../pagination";

const app = new Hono<AppEnv>();

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

app.get("/", async (c) => {
  const limitResult = parsePaginationParam(c.req.query("limit"), "limit", 50);
  if (!limitResult.ok) {
    return c.json({ error: "INVALID_LIMIT", message: limitResult.error }, 400);
  }
  const offsetResult = parsePaginationParam(c.req.query("offset"), "offset", 0);
  if (!offsetResult.ok) {
    return c.json(
      { error: "INVALID_OFFSET", message: offsetResult.error },
      400,
    );
  }

  const rawProviderId = c.req.query("providerId");
  if (rawProviderId !== undefined && !PROVIDER_ID_PATTERN.test(rawProviderId)) {
    return c.json(
      {
        error: "INVALID_PROVIDER_ID",
        message: "providerId must be a lowercase provider identifier",
      },
      400,
    );
  }

  const rawMode = c.req.query("mode");
  if (
    rawMode !== undefined &&
    !CONNECTED_ACCOUNT_MODES.includes(rawMode as ConnectedAccountMode)
  ) {
    return c.json(
      {
        error: "INVALID_MODE",
        message: `mode must be one of: ${CONNECTED_ACCOUNT_MODES.join(", ")}`,
      },
      400,
    );
  }

  let organizationId: string | undefined;
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    organizationId = user.organization_id;

    const page = await connectedCapabilitiesService.list({
      organizationId,
      limit: limitResult.value,
      offset: offsetResult.value,
      providerId: rawProviderId,
      mode: rawMode as ConnectedAccountMode | undefined,
    });

    return c.json(page);
  } catch (error) {
    // error-policy:J1 route boundary translates auth/projection failures into
    // structured responses; projection errors never leak row or token context.
    logger.error("[API] GET /api/v1/connections/accounts error", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof WorkerApiError) {
      return failureResponse(c, error);
    }
    return c.json(
      {
        error: "CONNECTED_ACCOUNTS_UNAVAILABLE",
        message: "Failed to list connected accounts",
      },
      500,
    );
  }
});

export default app;
