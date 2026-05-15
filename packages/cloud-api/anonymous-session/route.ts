/**
 * GET /api/anonymous-session - Get anonymous session data by token
 *
 * Public polling endpoint used by the frontend to refresh anon-session
 * message counts. The token is the lookup key; no other auth is required.
 */

import { Hono } from "hono";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isValidTokenFormat(token: string): boolean {
  return typeof token === "string" && token.length >= 16 && token.length <= 64;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.AGGRESSIVE));

app.get("/", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Session token is required" }, 400);
  }
  if (!isValidTokenFormat(token)) {
    logger.warn("[Anonymous Session API] Invalid token format");
    return c.json({ error: "Invalid session token format" }, 400);
  }

  const tokenHash = (await sha256Hex(token)).slice(0, 8);

  const session = await anonymousSessionsService.getByToken(token);
  if (!session) {
    logger.warn(`[Anonymous Session API] Session not found for token hash: ${tokenHash}`);
    return c.json({ error: "Session not found or expired" }, 404);
  }

  return c.json({
    success: true,
    session: {
      id: session.id,
      message_count: session.message_count,
      messages_limit: session.messages_limit,
      messages_remaining: session.messages_limit - session.message_count,
      is_active: session.is_active,
      expires_at: session.expires_at,
    },
  });
});

export default app;
