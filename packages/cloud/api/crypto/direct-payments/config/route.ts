import { Hono } from "hono";

import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { directWalletPaymentsService } from "@/lib/services/direct-wallet-payments";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), (c) => {
  return c.json(directWalletPaymentsService.getConfig(c.env));
});

export default app;
