/**
 * POST /api/v1/device-bus/devices — register / upsert a paired device.
 */

import { Hono } from "hono";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { devices } from "@/db/schemas";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const registerSchema = z.object({
  deviceId: z.string().uuid().optional(),
  platform: z.enum(["macos", "ios", "android", "windows", "linux", "web"]),
  pushToken: z.string().min(1).optional(),
  label: z.string().min(1).max(128).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
    }

    const { deviceId, platform, pushToken, label } = parsed.data;

    const [row] = await dbWrite
      .insert(devices)
      .values({
        id: deviceId,
        user_id: user.id,
        platform,
        push_token: pushToken ?? null,
        label: label ?? null,
        online: true,
      })
      .onConflictDoUpdate({
        target: devices.id,
        set: {
          platform,
          push_token: pushToken ?? null,
          label: label ?? null,
          online: true,
          last_seen_at: new Date(),
        },
      })
      .returning();

    if (!row) {
      logger.error("[device-bus] failed to insert device", {
        userId: user.id,
        platform,
      });
      return c.json({ error: "Failed to register device" }, 500);
    }

    return c.json({
      deviceId: row.id,
      userId: row.user_id,
      platform: row.platform,
      lastSeenAt: row.last_seen_at,
      online: row.online,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
