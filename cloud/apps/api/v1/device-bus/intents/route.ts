/**
 * POST /api/v1/device-bus/intents — publish a cross-device intent.
 *
 * Body: { kind: string, payload?: object, userId?: uuid }
 *
 * Stores the intent for the owner's devices to pick up via poll.
 */

import { Hono } from "hono";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { deviceIntents } from "@/db/schemas";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const publishSchema = z.object({
  kind: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()).optional(),
  userId: z.string().uuid().optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json().catch(() => null);
    const parsed = publishSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
    }

    const { kind, payload, userId } = parsed.data;
    // Caller can only publish for themselves; admin override is out of scope
    // for the initial rollout.
    const targetUserId = userId ?? user.id;
    if (targetUserId !== user.id) {
      return c.json({ error: "Cannot publish intents for a different user" }, 403);
    }

    const [row] = await dbWrite
      .insert(deviceIntents)
      .values({
        user_id: targetUserId,
        kind: kind.toLowerCase(),
        payload: payload ?? {},
        delivered_to: [],
      })
      .returning();

    if (!row) {
      logger.error("[device-bus] failed to insert intent", {
        userId: targetUserId,
        kind,
      });
      return c.json({ error: "Failed to publish intent" }, 500);
    }

    return c.json({
      intentId: row.id,
      kind: row.kind,
      createdAt: row.created_at,
      deliveredTo: [],
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
