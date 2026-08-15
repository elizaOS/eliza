/**
 * Leases and acknowledges proactive onboarding greetings for the authenticated
 * Discord gateway leader without deleting work before external delivery.
 */
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  acknowledgeDiscordProactiveGreetings,
  drainDiscordProactiveGreetings,
} from "@/lib/services/eliza-app/onboarding-proactive-greeting";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const app = new Hono<AppEnv>();

interface Acknowledgement {
  sessionId: string;
  leaseId: string;
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

    // error-policy:J3 Invalid JSON is an explicit invalid request below.
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Invalid greeting request" }, 400);
    }
    const action =
      "action" in body ? (body as { action?: unknown }).action : undefined;
    if (action === "ack") {
      const acknowledgements = parseAcknowledgements(
        (body as { acknowledgements?: unknown }).acknowledgements,
      );
      if (!acknowledgements) {
        return c.json({ error: "Invalid greeting acknowledgements" }, 400);
      }
      const acknowledged =
        await acknowledgeDiscordProactiveGreetings(acknowledgements);
      return c.json({ acknowledged });
    }
    if (action !== undefined && action !== "claim") {
      return c.json({ error: "Invalid greeting action" }, 400);
    }
    const greetings = await drainDiscordProactiveGreetings();
    return c.json({ greetings });
  } catch (err) {
    // error-policy:J1 This authenticated transport boundary returns the
    // standard structured cloud failure without fabricating queue success.
    logger.error("[internal/discord/eliza-app/pending-greetings]", {
      error: err,
    });
    return failureResponse(c, err);
  }
});

export default app;
