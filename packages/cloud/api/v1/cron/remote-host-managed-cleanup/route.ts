/** Bounded retry of stranded managed-network host compensation. */

import { Hono } from "hono";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  managedNetworkConfig,
  reconcileManagedNetworkCleanup,
} from "../../remote/managed-network";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const config = managedNetworkConfig(
      c.env as unknown as Record<string, unknown>,
    );
    if (!config) {
      return c.json(
        {
          success: false,
          error: "Managed-network cleanup is not configured.",
          code: "MANAGED_NETWORK_UNAVAILABLE",
        },
        503,
      );
    }
    const result = await reconcileManagedNetworkCleanup({
      config,
      repository: remoteHostsRepository,
    });
    if (result.failed > 0) {
      logger.error("[RemoteHosts] Managed-network cleanup left failures", {
        ...result,
      });
      return c.json({ success: false, ...result }, 503);
    }
    logger.info("[RemoteHosts] Managed-network cleanup completed", result);
    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("[RemoteHosts] Managed-network cleanup cron failed", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
