/** Fires due Shared reminders through the canonical scheduler and trusted gateway. */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { processDueSharedReminders } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-reminder-cron";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { isPersonalSharedTelegramEdgeEnabled } from "@/api-app/personal-shared-telegram-edge";
import { dispatchPersonalTelegramReminder } from "../../eliza-app/webhook/_telegram-edge";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const stats = await processDueSharedReminders(c.env, {
      ...(isPersonalSharedTelegramEdgeEnabled(c.env)
        ? {
            telegramDispatch: (input) =>
              dispatchPersonalTelegramReminder(c.env, input),
          }
        : {}),
    });
    logger.info("[SharedReminders] scheduled task sweep complete", stats);
    return c.json({ success: true, stats });
  } catch (error) {
    // error-policy:J1 cron boundary translates one observable failure response.
    logger.error("[SharedReminders] scheduled task sweep failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
