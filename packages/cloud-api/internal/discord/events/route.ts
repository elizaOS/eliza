import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { routeDiscordEvent } from "@/lib/services/gateway-discord/event-router";
import { DiscordEventPayloadSchema } from "@/lib/services/gateway-discord/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../_auth";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const payload = DiscordEventPayloadSchema.parse(await c.req.json());
    const result = await routeDiscordEvent(payload);
    return c.json({ success: true, ...result });
  } catch (err) {
    logger.error("[internal/discord/events]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
