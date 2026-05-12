/**
 * Anonymous User Authentication
 *
 * Handles authentication and session management for free/anonymous users.
 * Cookie creation is owned by the Hono route `apps/api/auth/anonymous-session`.
 *
 * Flow:
 * 1. User visits /dashboard/chat without auth
 * 2. System creates anonymous user + session (via API + Set-Cookie)
 * 3. Session cookie tracks the user (7 day expiry)
 * 4. User gets a limited number of free messages (tracked per session, NOT via credits)
 * 5. After limit, prompted to sign up
 * 6. On signup, anonymous data transfers to real account
 *
 * Security:
 * - httpOnly cookies prevent XSS attacks
 * - sameSite: strict prevents CSRF attacks
 * - Tokens hashed for logging
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import { userIdentities } from "@/db/schemas/user-identities";
import { getCookieValueFromHeader } from "@/lib/http/cookie-header";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
import type { UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

const ANON_SESSION_COOKIE = "eliza-anon-session";
const ANON_HOURLY_LIMIT = Number.parseInt(process.env.ANON_HOURLY_LIMIT || "10", 10);

type AnonymousUserWithOrganization = Omit<UserWithOrganization, "organization_id"> & {
  organization_id: null;
  organization: null;
};

function hashTokenForLogging(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

export async function checkAnonymousLimit(sessionId: string): Promise<{
  allowed: boolean;
  reason?: "message_limit" | "hourly_limit";
  remaining: number;
  limit: number;
}> {
  const session = await anonymousSessionsService.getByToken(sessionId);

  if (!session) {
    throw new Error("Session not found");
  }

  if (session.message_count >= session.messages_limit) {
    return {
      allowed: false,
      reason: "message_limit",
      remaining: 0,
      limit: session.messages_limit,
    };
  }

  const rateLimitResult = await anonymousSessionsService.checkRateLimit(session.id);

  if (!rateLimitResult.allowed) {
    return {
      allowed: false,
      reason: "hourly_limit",
      remaining: 0,
      limit: ANON_HOURLY_LIMIT,
    };
  }

  return {
    allowed: true,
    remaining: session.messages_limit - session.message_count,
    limit: session.messages_limit,
  };
}

export async function getAnonymousUser(request: Request): Promise<{
  user: UserWithOrganization;
  session: NonNullable<Awaited<ReturnType<typeof anonymousSessionsService.getByToken>>>;
} | null> {
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = getCookieValueFromHeader(cookieHeader, ANON_SESSION_COOKIE);

  logger.debug("[getAnonymousUser] Checking for anonymous session cookie:", {
    hasCookie: !!sessionToken,
    cookieName: ANON_SESSION_COOKIE,
    tokenHash: sessionToken ? hashTokenForLogging(sessionToken) : "N/A",
  });

  if (!sessionToken) {
    logger.debug("[getAnonymousUser] No session cookie found");
    return null;
  }

  const session = await anonymousSessionsService.getByToken(sessionToken);

  if (!session) {
    logger.debug(
      "[getAnonymousUser] Session not found in DB for token hash:",
      hashTokenForLogging(sessionToken),
    );
    return null;
  }

  logger.debug("[getAnonymousUser] Session found:", {
    sessionId: session.id,
    userId: session.user_id,
  });

  const user = await usersService.getById(session.user_id);

  if (!user) {
    logger.debug("[getAnonymousUser] User not found for ID:", session.user_id);
    return null;
  }

  const identity = await dbRead.query.userIdentities.findFirst({
    where: eq(userIdentities.user_id, user.id),
  });

  if (!identity?.is_anonymous) {
    logger.debug("[getAnonymousUser] User is not anonymous:", user.id);
    return null;
  }

  logger.debug("[getAnonymousUser] Anonymous user found:", user.id);

  const anonymousUser: AnonymousUserWithOrganization = {
    ...user,
    organization_id: null,
    organization: null,
  };

  return {
    user: anonymousUser as UserWithOrganization,
    session,
  };
}

export async function isAnonymousUser(request: Request): Promise<boolean> {
  const anon = await getAnonymousUser(request);
  return anon !== null;
}
