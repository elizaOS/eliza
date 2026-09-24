/** Removes expired mobile grants and tombstones their exact lifecycle credentials. */
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { cleanupExpiredMobileAppAuthGrants } from "@/lib/services/mobile-app-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const result = await cleanupExpiredMobileAppAuthGrants();
    if (result.integrityViolations > 0) {
      throw new ElizaError(
        "Expired mobile App Auth grants had unsafe credential ownership or state",
        {
          code: "MOBILE_APP_AUTH_CLEANUP_INTEGRITY_VIOLATION",
          context: { ...result },
          severity: "fatal",
        },
      );
    }
    if (result.remainingWork) {
      logger.warn(
        "[MobileAppAuth] Expired grant cleanup left a bounded backlog",
        { ...result },
      );
    } else {
      logger.info("[MobileAppAuth] Expired grant cleanup completed", {
        ...result,
      });
    }
    return c.json({ success: true, ...result });
  } catch (error) {
    // error-policy:J1 cron HTTP boundary reports the failed sweep to its dispatcher.
    logger.error("[MobileAppAuth] Expired grant cleanup failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
