/**
 * Leases and acknowledges proactive onboarding greetings for authenticated
 * webhook gateways serving Telegram and phone messaging transports.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  acknowledgeProactiveGreetings,
  drainProactiveGreetings,
  type ProactiveGreetingPlatform,
} from "@/lib/services/eliza-app/onboarding-proactive-greeting";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const app = new Hono<AppEnv>();
const WEBHOOK_PLATFORMS = new Set<ProactiveGreetingPlatform>([
  "telegram",
  "blooio",
  "twilio",
]);

interface Acknowledgement {
  sessionId: string;
  leaseId: string;
}

function parsePlatform(value: unknown): ProactiveGreetingPlatform | null {
  return typeof value === "string" &&
    WEBHOOK_PLATFORMS.has(value as ProactiveGreetingPlatform)
    ? (value as ProactiveGreetingPlatform)
    : null;
}

function parseAcknowledgements(value: unknown): Acknowledgement[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const parsed: Acknowledgement[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { sessionId, leaseId } = entry as Record<string, unknown>;
    if (
      typeof sessionId !== "string" ||
      sessionId.length < 8 ||
      sessionId.length > 180 ||
      typeof leaseId !== "string" ||
      !/^[A-Za-z0-9_-]{1,25}$/.test(leaseId)
    ) {
      return null;
    }
    parsed.push({ sessionId, leaseId });
  }
  return parsed;
}

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;
    if (
      auth.service !== "webhook-gateway" &&
      auth.service !== "shared-secret"
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
    // error-policy:J3 malformed internal input is explicitly rejected.
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Invalid greeting request" }, 400);
    }
    const input = body as Record<string, unknown>;
    const platform = parsePlatform(input.platform);
    if (!platform) return c.json({ error: "Invalid greeting platform" }, 400);
    if (input.action === "ack") {
      const acknowledgements = parseAcknowledgements(input.acknowledgements);
      if (!acknowledgements) {
        return c.json({ error: "Invalid greeting acknowledgements" }, 400);
      }
      return c.json({
        acknowledged: await acknowledgeProactiveGreetings(
          platform,
          acknowledgements,
        ),
      });
    }
    if (input.action !== undefined && input.action !== "claim") {
      return c.json({ error: "Invalid greeting action" }, 400);
    }
    return c.json({ greetings: await drainProactiveGreetings(platform) });
  } catch (error) {
    // error-policy:J1 authenticated transport boundary returns structured failure.
    logger.error("[internal/webhook/eliza-app/pending-greetings]", { error });
    return failureResponse(c, error);
  }
});

export default app;
