/**
 * Anonymous User Authentication
 *
 * Handles authentication and session management for free/anonymous users.
 * Anonymous users can access limited features without signing up.
 *
 * Flow:
 * 1. User visits /dashboard/chat without auth
 * 2. System creates anonymous user + session
 * 3. Session cookie tracks the user (7 day expiry)
 * 4. User gets 10 free messages (tracked per session, NOT via credits)
 * 5. After limit, prompted to sign up
 * 6. On signup, anonymous data transfers to real account
 *
 * Security:
 * - httpOnly cookies prevent XSS attacks
 * - sameSite: strict prevents CSRF attacks
 * - IP-based abuse detection in production
 * - Tokens hashed for logging
 *
 * NOTE: This module is being deprecated in favor of lib/session/session.ts
 * Use getOrCreateSessionUser() from @/lib/session for new code.
 */

import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { usersService } from "@/lib/services/users";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { logger } from "@/lib/utils/logger";
import type { UserWithOrganization, User } from "@/lib/types";

// Constants - can be overridden via environment variables
const ANON_SESSION_COOKIE = "eliza-anon-session";
const ANON_SESSION_EXPIRY_DAYS = Number.parseInt(
  process.env.ANON_SESSION_EXPIRY_DAYS || "7",
  10,
);
// Affiliate flow uses ANON_MESSAGE_LIMIT (5 messages)
// Public agent chat uses PUBLIC_CHAT_MESSAGE_LIMIT (3 messages)
const PUBLIC_CHAT_MESSAGE_LIMIT = Number.parseInt(
  process.env.PUBLIC_CHAT_MESSAGE_LIMIT || "3",
  10,
);
const ANON_HOURLY_LIMIT = Number.parseInt(
  process.env.ANON_HOURLY_LIMIT || "10",
  10,
);

/**
 * Type for anonymous user (no organization)
 */
type AnonymousUserWithOrganization = Omit<User, "organization_id"> & {
  organization_id: null;
  organization: null;
};

/**
 * Hash a token for safe logging (prevents token exposure in logs)
 */
function hashTokenForLogging(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Get client IP address from headers
 *
 * Priority: x-real-ip (trusted, set by Vercel/proxy) > x-forwarded-for (first IP)
 * Note: x-forwarded-for can be spoofed by clients, x-real-ip is more trusted
 */
async function getClientIp(): Promise<string | undefined> {
  const headersList = await headers();
  const realIp = headersList.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }
  // Fallback to x-forwarded-for (first IP in the chain)
  const forwardedFor = headersList
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwardedFor || undefined;
}

/**
 * Get user agent from headers
 */
async function getUserAgent(): Promise<string | undefined> {
  const headersList = await headers();
  return headersList.get("user-agent") || undefined;
}

/**
 * Get or create an anonymous user session
 *
 * This function:
 * 1. Checks for existing session cookie
 * 2. Validates session is still active and not expired
 * 3. Returns existing user if valid
 * 4. Creates new anonymous user + session if needed
 * 5. Sets HTTP-only session cookie
 *
 * @returns User and session data
 */
export async function getOrCreateAnonymousUser(): Promise<{
  user: UserWithOrganization;
  session: Awaited<ReturnType<typeof anonymousSessionsService.getByToken>>;
  isNew: boolean;
  sessionToken?: string;
  expiresAt?: Date;
}> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(ANON_SESSION_COOKIE)?.value;

  if (sessionToken) {
    const session = await anonymousSessionsService.getByToken(sessionToken);

    if (session) {
      const user = await usersService.getById(session.user_id);

      if (user?.is_anonymous) {
        logger.info("[auth-anonymous] Existing anonymous session found", {
          userId: user.id,
          messageCount: session.message_count,
          remaining: session.messages_limit - session.message_count,
        });

        const anonymousUser: AnonymousUserWithOrganization = {
          ...user,
          organization_id: null,
          organization: null,
        };

        return {
          user: anonymousUser as UserWithOrganization,
          session,
          isNew: false,
        };
      }
    }
  }

  const newSessionToken = nanoid(32);
  const expiresAt = new Date(
    Date.now() + ANON_SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
  const ipAddress = await getClientIp();
  const userAgent = await getUserAgent();
  // NOTE: IP-based anonymous-session abuse checks intentionally removed.
  // We still record IP/user-agent for analytics/auditing, but do not block by IP.

  const { newUser, newSession } = await createAnonymousUserAndSession({
    sessionToken: newSessionToken,
    expiresAt,
    ipAddress,
    userAgent,
    messagesLimit: PUBLIC_CHAT_MESSAGE_LIMIT,
  });

  cookieStore.set(ANON_SESSION_COOKIE, newSessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });

  const anonymousUser: AnonymousUserWithOrganization = {
    ...newUser,
    organization_id: null,
    organization: null,
  };

  return {
    user: anonymousUser as UserWithOrganization,
    session: newSession,
    sessionToken: newSessionToken,
    expiresAt,
    isNew: true,
  };
}

/**
 * Check if user has reached their free message limit
 */
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

  const rateLimitResult = await anonymousSessionsService.checkRateLimit(
    session.id,
  );

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

/**
 * Get anonymous user from cookie (if exists)
 */
export async function getAnonymousUser(): Promise<{
  user: UserWithOrganization;
  session: Awaited<ReturnType<typeof anonymousSessionsService.getByToken>>;
} | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(ANON_SESSION_COOKIE)?.value;

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

  if (!user.is_anonymous) {
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

/**
 * Check if current request is from an anonymous user
 */
export async function isAnonymousUser(): Promise<boolean> {
  const anon = await getAnonymousUser();
  return anon !== null;
}
