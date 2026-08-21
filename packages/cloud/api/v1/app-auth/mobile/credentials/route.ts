/**
 * Lists the signed-in account's native app credentials without exposing secret
 * material. This recovery surface lets a user identify and disconnect a lost
 * device even when that device's Keychain credential is unavailable.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireSessionUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
