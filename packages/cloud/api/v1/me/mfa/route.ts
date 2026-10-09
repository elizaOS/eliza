/**
 * MFA status contract for the account-security console.
 *
 * The Worker does not yet own an enrollment provider, but the console needs a
 * real authenticated endpoint so feature absence is explicit instead of a route
 * miss. When TOTP/WebAuthn enrollment ships, this route should swap the
 * unavailable DTO for the user's enrolled-factor state.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    return c.json({
      available: false,
      reason: "mfa_enrollment_unavailable",
      enrolled: false,
      method: null,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
