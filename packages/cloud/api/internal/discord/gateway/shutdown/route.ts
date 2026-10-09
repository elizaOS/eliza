// Handles internal cloud API internal discord gateway shutdown route traffic with service-to-service auth.

import { discordConnectionsRepository } from "@elizaos/cloud-shared/db/repositories/discord-connections";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { requireInternalAuth } from "../../../_auth";

const shutdownSchema = z.object({
  pod_name: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9-]+$/)
    .optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const decodedBody = await decodeOptionalRequestJson(c.req);
    if (!decodedBody.ok) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const body = shutdownSchema.parse(decodedBody.value);
    const podName = body.pod_name ?? auth.podName;
    const released =
      await discordConnectionsRepository.clearPodAssignments(podName);
    return c.json({ success: true, released });
  } catch (err) {
    logger.error("[internal/discord/gateway/shutdown]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
