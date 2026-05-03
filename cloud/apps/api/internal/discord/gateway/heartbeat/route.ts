import { Hono } from "hono";
import { z } from "zod";
import { discordConnectionsRepository } from "@/db/repositories/discord-connections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const podNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9-]+$/);

const heartbeatSchema = z.object({
  pod_name: podNameSchema,
  connection_ids: z.array(z.string().uuid()).default([]),
  connection_stats: z
    .array(
      z.object({
        id: z.string().uuid(),
        guildCount: z.number().int().min(0).optional(),
        eventsReceived: z.number().int().min(0).optional(),
        eventsRouted: z.number().int().min(0).optional(),
      }),
    )
    .default([]),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const body = heartbeatSchema.parse(await c.req.json());
    const updated = await discordConnectionsRepository.updateHeartbeatBatch(
      body.pod_name,
      body.connection_ids,
    );

    await Promise.all(
      body.connection_stats.map((stats) =>
        discordConnectionsRepository.updateStats(stats.id, {
          guildCount: stats.guildCount,
          eventsReceived: stats.eventsReceived,
          eventsRouted: stats.eventsRouted,
        }),
      ),
    );

    return c.json({ success: true, updated });
  } catch (err) {
    logger.error("[internal/discord/gateway/heartbeat]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
