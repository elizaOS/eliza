/** Handles internal cloud API internal discord events route traffic with service-to-service auth. */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { routeDiscordEvent } from "@/lib/services/gateway-discord/event-router";
import { DiscordEventPayloadSchema } from "@/lib/services/gateway-discord/schemas";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../_auth";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedRawBody.value;
    const payload = DiscordEventPayloadSchema.parse(rawBody);
    const result = await routeDiscordEvent(payload);
    return c.json({ success: true, ...result });
  } catch (err) {
    logger.error("[internal/discord/events]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
