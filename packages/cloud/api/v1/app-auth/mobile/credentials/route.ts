/**
 * Lists the signed-in account's native app credentials without exposing secret
 * material. This recovery surface lets a user identify and disconnect a lost
 * device even when that device's Keychain credential is unavailable.
 */

import { requireSessionUserWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@elizaos/cloud-shared/lib/services/api-keys";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireSessionUserWithOrg(c);
    const credentials = await apiKeysService.listMobileCredentialsForAccount(
      user.id,
      user.organization_id,
    );
    return c.json({
      success: true,
      credentials,
    });
  } catch (error) {
    // error-policy:J1 Account recovery failures remain explicit HTTP errors.
    logger.error("[MobileAppAuth] Credential listing failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
