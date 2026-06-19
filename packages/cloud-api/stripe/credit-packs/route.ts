/**
 * GET /api/stripe/credit-packs
 * Public — lists active credit packs available for purchase.
 */

import { Hono } from "hono";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { creditsService } from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.RELAXED));

app.get("/", async (c) => {
  try {
    const creditPacks = await creditsService.listActiveCreditPacks();
    return c.json({ creditPacks });
  } catch (error) {
    logger.error("Error fetching credit packs:", error);
    if (c.req.query("dbg") === "rwmig") {
      const e = error as { message?: string; cause?: unknown };
      const cause = e?.cause as { message?: string; code?: string; name?: string } | undefined;
      return c.json(
        {
          error: "Failed to fetch credit packs",
          _dbg: {
            message: String(e?.message ?? ""),
            causeMessage: String(cause?.message ?? e?.cause ?? ""),
            causeCode: String(cause?.code ?? ""),
            causeName: String(cause?.name ?? ""),
            hasHyperdrive: !!(c.env as { HYPERDRIVE?: unknown })?.HYPERDRIVE,
          },
        },
        500,
      );
    }
    return c.json({ error: "Failed to fetch credit packs" }, 500);
  }
});

export default app;
