/**
 * POST /api/auth/cli-session
 * Creates a new CLI authentication session for command-line tool authentication.
 * Session ids are server-generated UUIDs: accepting client-chosen ids let any
 * unauthenticated caller squat ids and insert unbounded rows (row-spam).
 */

import { Hono } from "hono";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { cliAuthSessionsService } from "@/lib/services/cli-auth-sessions";
import { getCorsHeaders } from "@/lib/utils/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

// Pre-auth session-create endpoint: bound DB-row creation per source IP. Same
// fail-closed-with-fallback posture as steward-session (login availability is
// preserved through a Redis outage by the per-isolate bucket).
app.use(
  rateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: getIpKey,
    failClosed: true,
    redisUnavailableFallback: {
      namespace: "cli-session",
    },
  }),
);

app.options("/", (c) => {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(c.req.header("origin") ?? null),
  });
});

app.post("/", async (c) => {
  const corsHeaders = getCorsHeaders(c.req.header("origin") ?? null);
  try {
    // A client-supplied sessionId is deliberately ignored; the poll/complete
    // routes only accept the server-issued UUID format.
    const session = await cliAuthSessionsService.createSession(
      crypto.randomUUID(),
    );

    return c.json(
      {
        sessionId: session.session_id,
        status: session.status,
        expiresAt: session.expires_at,
      },
      201,
      corsHeaders,
    );
  } catch (error) {
    logger.error("Error creating CLI auth session:", error);
    return c.json(
      { error: "Failed to create authentication session" },
      500,
      corsHeaders,
    );
  }
});

export default app;
