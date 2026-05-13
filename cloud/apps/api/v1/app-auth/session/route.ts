/**
 * GET /api/v1/app-auth/session
 *
 * Returns the current user (id, email, name, avatar, created_at) for an
 * authenticated request. Accepts a Steward JWT or an API key. If X-App-Id is
 * supplied, the referenced app is also returned.
 *
 * CORS is handled globally in src/index.ts.
 */

import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { dbRead } from "@/db/client";
import { apps } from "@/db/schemas/apps";
import {
  AuthenticationError,
  ForbiddenError,
  failureResponse,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { consumeAppAuthCode, looksLikeAppAuthCode } from "@/lib/services/app-auth-codes";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function readBearer(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

function readRequestedAppId(c: Context): string | null {
  return c.req.header("X-App-Id") || c.req.header("x-app-id") || null;
}

async function readAppInfo(appId: string | null): Promise<{ id: string; name: string } | null> {
  if (!appId) return null;
  const [row] = await dbRead
    .select({ id: apps.id, name: apps.name })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  return row ?? null;
}

async function buildSessionResponse(
  c: Context,
  input: {
    userId: string;
    email?: string | null;
    appId?: string | null;
  },
): Promise<Response> {
  const fullUser = await usersService.getById(input.userId);
  if (!fullUser) throw AuthenticationError("User not found");

  const appInfo = await readAppInfo(input.appId ?? null);

  logger.info("App auth session verified", { userId: input.userId, appId: input.appId });

  return c.json({
    success: true,
    user: {
      id: input.userId,
      email: fullUser.email ?? input.email ?? null,
      name: fullUser.name ?? null,
      avatar: fullUser.avatar ?? null,
      createdAt: fullUser.created_at ?? null,
    },
    app: appInfo,
  });
}

app.get("/", async (c) => {
  try {
    const bearer = readBearer(c);
    if (looksLikeAppAuthCode(bearer)) {
      const codeRecord = await consumeAppAuthCode(bearer);
      if (!codeRecord) throw AuthenticationError("Invalid or expired authorization code");

      const requestedAppId = readRequestedAppId(c);
      if (requestedAppId && requestedAppId !== codeRecord.appId) {
        throw ForbiddenError("Authorization code was issued for a different app");
      }

      return await buildSessionResponse(c, {
        userId: codeRecord.userId,
        appId: codeRecord.appId,
      });
    }

    const authed = await requireUserOrApiKey(c);
    return await buildSessionResponse(c, {
      userId: authed.id,
      email: authed.email,
      appId: readRequestedAppId(c),
    });
  } catch (error) {
    logger.error("App auth session error:", error);
    return failureResponse(c, error);
  }
});

export default app;
