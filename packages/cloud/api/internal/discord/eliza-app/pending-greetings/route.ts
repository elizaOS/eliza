// Drains pending proactive onboarding greetings for the Discord gateway with
// service-to-service auth. The gateway leader polls this route and delivers
// each claimed greeting as a proactive DM; claiming is atomic in the
// coordinator (at-most-once), so the gateway never double-sends.
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { drainDiscordProactiveGreetings } from "@/lib/services/eliza-app/onboarding-proactive-greeting";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const greetings = await drainDiscordProactiveGreetings();
    return c.json({ greetings });
  } catch (err) {
    logger.error("[internal/discord/eliza-app/pending-greetings]", {
      error: err,
    });
    return failureResponse(c, err);
  }
});

export default app;
