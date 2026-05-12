import { Hono } from "hono";
import { z } from "zod";
import { discordConnectionsRepository } from "@/db/repositories/discord-connections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
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

    const body = shutdownSchema.parse(await c.req.json().catch(() => ({})));
    const podName = body.pod_name ?? auth.podName;
    const released = await discordConnectionsRepository.clearPodAssignments(podName);
    return c.json({ success: true, released });
  } catch (err) {
    logger.error("[internal/discord/gateway/shutdown]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
