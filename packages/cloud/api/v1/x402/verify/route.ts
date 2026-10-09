/**
 * POST /api/v1/x402/verify
 * Verify an x402 payment header (EIP-3009 TransferWithAuthorization).
 * No auth — payment IS auth.
 */

import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { x402FacilitatorService } from "@elizaos/cloud-shared/lib/services/x402-facilitator";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ isValid: false, invalidReason: "invalid_json_body" }, 400);
  }

  const { paymentPayload, paymentRequirements } = body;

  if (!paymentPayload || !paymentRequirements) {
    return c.json(
      {
        isValid: false,
        invalidReason:
          "missing_fields: paymentPayload and paymentRequirements are required",
      },
      400,
    );
  }

  try {
    const result = await x402FacilitatorService.verify(
      paymentPayload as Parameters<typeof x402FacilitatorService.verify>[0],
      paymentRequirements as Parameters<
        typeof x402FacilitatorService.verify
      >[1],
    );

    return c.json(result, result.isValid ? 200 : 400);
  } catch (err) {
    // error-policy:J1 route boundary — verification failures return a constant
    // reason to unauthenticated callers; upstream RPC/provider detail stays in
    // server logs only.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[x402-verify] Verification error: ${msg}`);
    return c.json({ isValid: false, invalidReason: "internal_error" }, 500);
  }
});

export default app;
