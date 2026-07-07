/**
 * Web Push subscription store.
 *
 *   POST   /api/v1/web-push/subscriptions   — persist a PushSubscription keyed to (user, agent)
 *   DELETE /api/v1/web-push/subscriptions   — remove a subscription on unsubscribe
 *
 * The client (PR-1) creates a `PushSubscription` inside a user gesture and
 * POSTs its `toJSON()` here. The private VAPID key never touches this route;
 * only the public UA keys (`p256dh`/`auth`) + endpoint are stored. Deletes are
 * scoped to the authenticated user so no one can remove another user's device.
 */

import { Hono } from "hono";
import { z } from "zod";
import { webPushSubscriptionsRepository } from "@/db/repositories/web-push-subscriptions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import { isValidPushEndpoint } from "@/lib/web-push";
import type { AppEnv } from "@/types/cloud-worker-env";

// Web Push endpoints must be HTTPS URLs to a PUBLIC push service. The sender
// later POSTs to whatever is persisted, so validating here (SSRF guard) keeps a
// stored endpoint from ever being an internal service the Worker can reach.
const pushEndpoint = z.string().url().refine(isValidPushEndpoint, {
  message: "endpoint must be an https URL to a public push service",
});

const subscribeSchema = z.object({
  agentId: z.string().uuid(),
  subscription: z.object({
    endpoint: pushEndpoint,
    keys: z.object({
      p256dh: z.string().min(1).max(255),
      auth: z.string().min(1).max(255),
    }),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: pushEndpoint,
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json().catch(() => {
      // error-policy:J3 malformed subscription JSON is invalid input for this request body.
      return null;
    });
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid subscription" },
        400,
      );
    }

    const { agentId, subscription } = parsed.data;
    const row = await webPushSubscriptionsRepository.upsert({
      userId: user.id,
      agentId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });

    logger.info("[web-push] subscription stored", {
      userId: user.id,
      agentId,
    });

    return c.json({ id: row.id, ok: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json().catch(() => {
      // error-policy:J3 malformed unsubscribe JSON is invalid input for this request body.
      return null;
    });
    const parsed = unsubscribeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid endpoint" },
        400,
      );
    }

    const removed = await webPushSubscriptionsRepository.deleteByEndpoint(
      user.id,
      parsed.data.endpoint,
    );

    return c.json({ ok: true, removed });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
