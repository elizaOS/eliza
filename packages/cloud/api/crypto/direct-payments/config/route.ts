// Handles cloud API crypto direct payments config route traffic with route-local auth expectations.

import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { directWalletPaymentsService } from "@elizaos/cloud-shared/lib/services/direct-wallet-payments";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), (c) => {
  return c.json(directWalletPaymentsService.getConfig(c.env));
});

export default app;
