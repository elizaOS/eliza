/**
 * POST /api/auth/migrate-anonymous
 * Migrates anonymous user data to the authenticated user. Called by the SPA
 * after a successful Steward authentication.
 */

import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUser } from "@/lib/auth/workers-hono-auth";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { migrateAnonymousSession } from "@/lib/session";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ANON_SESSION_COOKIE = "eliza-anon-session";

async function hashTokenForLogging(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUser(c);

    if (!user.steward_id) {
      return c.json({ error: "User does not have a Steward ID" }, 400);
    }

    let sessionToken: string | undefined = getCookie(c, ANON_SESSION_COOKIE);
    if (!sessionToken) {
      const body = (await c.req.json().catch(() => ({}))) as { sessionToken?: string };
      sessionToken = body.sessionToken;
    }

    if (!sessionToken) {
      return c.json({
        success: true,
        message: "No anonymous session to migrate",
        migrated: false,
      });
    }

    const anonSession = await anonymousSessionsService.getByToken(sessionToken);
    if (!anonSession) {
      logger.info(
        `[Migrate Anonymous] Anonymous session not found for token hash: ${await hashTokenForLogging(sessionToken)}`,
      );
      return c.json({
        success: true,
        message: "Anonymous session not found or already migrated",
        migrated: false,
      });
    }

    if (anonSession.converted_at) {
      deleteCookie(c, ANON_SESSION_COOKIE, { path: "/" });
      return c.json({ success: true, message: "Session already migrated", migrated: false });
    }

    const migrationResult = await migrateAnonymousSession(anonSession.user_id, user.steward_id);

    deleteCookie(c, ANON_SESSION_COOKIE, { path: "/" });

    return c.json({
      success: true,
      message: "Anonymous data migrated successfully",
      migrated: true,
      details: migrationResult.mergedData,
    });
  } catch (error) {
    logger.error("[Migrate Anonymous] Error during migration:", error);

    if (error instanceof Error && error.message === "Anonymous user not found") {
      return c.json({
        success: true,
        message: "No anonymous data to migrate",
        migrated: false,
      });
    }
    return failureResponse(c, error);
  }
});

export default app;
