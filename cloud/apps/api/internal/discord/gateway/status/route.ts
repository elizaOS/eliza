import { Hono } from "hono";
import { z } from "zod";
import { discordConnectionsRepository } from "@/db/repositories/discord-connections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { ConnectionStatusUpdateSchema } from "@/lib/services/gateway-discord/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const podNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9-]+$/);

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const podName = podNameSchema.parse(c.req.query("pod") ?? auth.podName);
    const connections = await discordConnectionsRepository.findByAssignedPod(podName);
    return c.json({
      podName,
      connections: connections.map((connection) => ({
        connectionId: connection.id,
        organizationId: connection.organization_id,
        applicationId: connection.application_id,
        characterId: connection.character_id,
        status: connection.status,
        errorMessage: connection.error_message,
        guildCount: connection.guild_count ?? 0,
        eventsReceived: connection.events_received ?? 0,
        eventsRouted: connection.events_routed ?? 0,
        lastHeartbeat: connection.last_heartbeat?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    logger.error("[internal/discord/gateway/status:get]", { error: err });
    return failureResponse(c, err);
  }
});

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const body = ConnectionStatusUpdateSchema.parse(await c.req.json());
    const connection = await discordConnectionsRepository.updateStatus(
      body.connection_id,
      body.status,
      body.pod_name,
      body.error_message,
      body.bot_user_id,
    );
    if (!connection) {
      return c.json({ error: "connection_not_found" }, 404);
    }
    return c.json({ success: true, connectionId: connection.id, status: connection.status });
  } catch (err) {
    logger.error("[internal/discord/gateway/status:post]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
