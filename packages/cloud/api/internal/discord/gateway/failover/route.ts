/** Handles internal cloud API internal discord gateway failover route traffic with service-to-service auth. */

import { Hono } from "hono";
import { discordConnectionsRepository } from "@/db/repositories/discord-connections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { FailoverRequestSchema } from "@/lib/services/gateway-discord/schemas";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const RECENT_HEARTBEAT_THRESHOLD_MS = 45_000;

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedRawBody.value;
    const body = FailoverRequestSchema.parse(rawBody);
    if (body.claiming_pod === body.dead_pod) {
      return c.json({ error: "cannot_claim_self" }, 400);
    }

    const podStillHealthy =
      await discordConnectionsRepository.hasRecentHeartbeat(
        body.dead_pod,
        RECENT_HEARTBEAT_THRESHOLD_MS,
      );
    if (podStillHealthy) {
      return c.json({ error: "pod_still_healthy", claimed: 0 }, 409);
    }

    const claimed = await discordConnectionsRepository.reassignFromDeadPod(
      body.dead_pod,
      body.claiming_pod,
      RECENT_HEARTBEAT_THRESHOLD_MS,
    );
    return c.json({ success: true, claimed });
  } catch (err) {
    logger.error("[internal/discord/gateway/failover]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
