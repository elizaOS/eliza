/**
 * Session Management
 *
 * Single source of truth for all session operations.
 * Handles both authenticated (Privy) and anonymous sessions.
 *
 * Performance: Uses cached getCurrentUser from auth.ts for authenticated users
 * to avoid redundant Privy API calls.
 */

import { nanoid } from "nanoid";
import { cookies, headers } from "next/headers";
import type { NextRequest } from "next/server";
import { db } from "@/db/client";
import {
  users,
  anonymousSessions,
  organizations,
  conversations,
  userCharacters,
  elizaRoomCharactersTable,
} from "@/db/schemas";
import { participantTable } from "@/db/schemas/eliza";
import type { AnonymousSession } from "@/db/schemas";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";
import { usersService } from "@/lib/services/users";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import type { UserWithOrganization } from "@/lib/types";
import { getCurrentUser } from "@/lib/auth";

const ANON_SESSION_COOKIE = "eliza-anon-session";
const ANON_SESSION_EXPIRY_DAYS = 7;
const DEFAULT_MESSAGE_LIMIT = 10;
const DEFAULT_HOURLY_LIMIT = 10;

export interface SessionUser {
  userId: string;
  isAnonymous: boolean;
  organizationId: string | null;
  sessionToken: string | null;
  messageCount: number;
  messagesLimit: number;
  messagesRemaining: number;
  metadata: {
    ipAddress?: string;
    userAgent?: string;
    fingerprint?: string;
    createdAt: Date;
    expiresAt?: Date;
  };
  user: UserWithOrganization;
  anonymousSession?: AnonymousSession;
}

export interface SessionTokenSources {
  header?: string | null;
  cookie?: string | null;
  body?: string | null;
  query?: string | null;
}

async function getClientInfo(): Promise<{
  ipAddress?: string;
  userAgent?: string;
}> {
  try {
    const headersList = await headers();
    return {
      ipAddress:
        headersList.get("x-forwarded-for")?.split(",")[0] ||
        headersList.get("x-real-ip") ||
        undefined,
      userAgent: headersList.get("user-agent") || undefined,
    };
  } catch {
    return {};
  }
}

async function getSessionTokenFromCookie(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    return cookieStore.get(ANON_SESSION_COOKIE)?.value || null;
  } catch {
    return null;
  }
}

async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  try {
    const cookieStore = await cookies();
    cookieStore.set(ANON_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
  } catch (error) {
    logger.warn("[Session] Could not set session cookie:", error);
  }
}

async function clearSessionCookie(): Promise<void> {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(ANON_SESSION_COOKIE);
  } catch {
    logger.debug("[Session] Could not clear session cookie");
  }
}

/**
 * Get or create a session user - single entry point for all auth flows
 *
 * Priority:
 * 1. Check for Privy auth token (authenticated user)
 * 2. Check provided session token (from header/body/query)
 * 3. Check session cookie
 * 4. Create new anonymous session if none found
 */
export async function getOrCreateSessionUser(
  request?: NextRequest,
  options?: {
    tokenSources?: SessionTokenSources;
    createIfMissing?: boolean;
  },
): Promise<SessionUser> {
  const { tokenSources, createIfMissing = true } = options || {};
  const logPrefix = "[Session]";

  logger.debug(`${logPrefix} Starting session resolution`, {
    hasRequest: !!request,
    hasSources: !!tokenSources,
    createIfMissing,
  });

  // Step 1: Try Privy authentication first using cached getCurrentUser
  // This leverages Redis caching to avoid redundant Privy API calls
  try {
    const user = await getCurrentUser();

    if (user && user.organization_id) {
      const cookieStore = await cookies();
      const privyToken = cookieStore.get("privy-token")?.value;

      logger.info(`${logPrefix} Authenticated user session (cached)`, {
        userId: user.id,
        orgId: user.organization_id,
      });

      return {
        userId: user.id,
        isAnonymous: false,
        organizationId: user.organization_id,
        sessionToken: privyToken || null,
        messageCount: 0,
        messagesLimit: Infinity,
        messagesRemaining: Infinity,
        metadata: {
          createdAt: user.created_at,
        },
        user,
      };
    }
  } catch (error) {
    logger.debug(`${logPrefix} Privy auth failed:`, error);
  }

  // Step 2: Try provided session tokens (in priority order)
  const providedToken =
    tokenSources?.header ||
    tokenSources?.body ||
    tokenSources?.query ||
    request?.headers.get("X-Anonymous-Session") ||
    null;

  if (providedToken) {
    logger.debug(
      `${logPrefix} Checking provided token:`,
      providedToken.slice(0, 8) + "...",
    );

    const session = await anonymousSessionsService.getByToken(providedToken);
    if (session) {
      const sessionUser = await usersService.getWithOrganization(
        session.user_id,
      );
      if (sessionUser && sessionUser.is_anonymous) {
        logger.info(
          `${logPrefix} Valid anonymous session from provided token`,
          {
            userId: sessionUser.id,
            messageCount: session.message_count,
          },
        );

        return buildAnonymousSessionUser(sessionUser, session, providedToken);
      }
    }
    logger.debug(`${logPrefix} Provided token invalid or expired`);
  }

  // Step 3: Try session cookie
  const cookieToken =
    tokenSources?.cookie || (await getSessionTokenFromCookie());
  if (cookieToken) {
    logger.debug(
      `${logPrefix} Checking cookie token:`,
      cookieToken.slice(0, 8) + "...",
    );

    const session = await anonymousSessionsService.getByToken(cookieToken);
    if (session) {
      const sessionUser = await usersService.getWithOrganization(
        session.user_id,
      );
      if (sessionUser && sessionUser.is_anonymous) {
        logger.info(`${logPrefix} Valid anonymous session from cookie`, {
          userId: sessionUser.id,
          messageCount: session.message_count,
        });

        return buildAnonymousSessionUser(sessionUser, session, cookieToken);
      }
    }
    logger.debug(`${logPrefix} Cookie token invalid or expired`);
  }

  // Step 4: Create new anonymous session if allowed
  if (!createIfMissing) {
    throw new Error("No valid session found and creation disabled");
  }

  logger.info(`${logPrefix} Creating new anonymous session...`);
  return createNewAnonymousSession();
}

async function buildAnonymousSessionUser(
  user: UserWithOrganization,
  session: AnonymousSession,
  token: string,
): Promise<SessionUser> {
  // Anonymous users have no organization - construct proper UserWithOrganization
  const anonymousUser: UserWithOrganization = {
    ...user,
    organization_id: null,
    organization: null,
  };

  return {
    userId: user.id,
    isAnonymous: true,
    organizationId: null,
    sessionToken: token,
    messageCount: session.message_count,
    messagesLimit: session.messages_limit,
    messagesRemaining: Math.max(
      0,
      session.messages_limit - session.message_count,
    ),
    metadata: {
      ipAddress: session.ip_address || undefined,
      userAgent: session.user_agent || undefined,
      fingerprint: session.fingerprint || undefined,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
    },
    user: anonymousUser,
    anonymousSession: session,
  };
}

async function createNewAnonymousSession(): Promise<SessionUser> {
  const sessionToken = nanoid(32);
  const expiresAt = new Date(
    Date.now() + ANON_SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
  const clientInfo = await getClientInfo();
  // NOTE: IP-based anonymous-session abuse checks intentionally removed.

  const [newUser] = await db
    .insert(users)
    .values({
      is_anonymous: true,
      anonymous_session_id: sessionToken,
      organization_id: null,
      is_active: true,
      expires_at: expiresAt,
      role: "member",
    })
    .returning();

  const newSession = await anonymousSessionsService.create({
    session_token: sessionToken,
    user_id: newUser.id,
    expires_at: expiresAt,
    ip_address: clientInfo.ipAddress,
    user_agent: clientInfo.userAgent,
    messages_limit: DEFAULT_MESSAGE_LIMIT,
  });

  await setSessionCookie(sessionToken, expiresAt);

  logger.info("[Session] Created new anonymous session", {
    userId: newUser.id,
    sessionId: newSession.id,
    expiresAt,
  });

  // Construct UserWithOrganization from the newly created User
  const anonymousUser: UserWithOrganization = {
    ...newUser,
    organization_id: null,
    organization: null,
  };

  return {
    userId: newUser.id,
    isAnonymous: true,
    organizationId: null,
    sessionToken,
    messageCount: 0,
    messagesLimit: DEFAULT_MESSAGE_LIMIT,
    messagesRemaining: DEFAULT_MESSAGE_LIMIT,
    metadata: {
      ipAddress: clientInfo.ipAddress,
      userAgent: clientInfo.userAgent,
      createdAt: new Date(),
      expiresAt,
    },
    user: anonymousUser,
    anonymousSession: newSession,
  };
}

/**
 * Increment message count for a session user
 */
export async function incrementSessionMessageCount(
  sessionUser: SessionUser,
): Promise<{
  allowed: boolean;
  newCount: number;
  remaining: number;
  reason?: "message_limit" | "hourly_limit";
}> {
  if (!sessionUser.isAnonymous) {
    return { allowed: true, newCount: 0, remaining: Infinity };
  }

  if (!sessionUser.anonymousSession) {
    throw new Error("No anonymous session found");
  }

  const session = sessionUser.anonymousSession;

  if (session.message_count >= session.messages_limit) {
    return {
      allowed: false,
      newCount: session.message_count,
      remaining: 0,
      reason: "message_limit",
    };
  }

  const rateLimitResult = await anonymousSessionsService.checkRateLimit(
    session.id,
  );
  if (!rateLimitResult.allowed) {
    return {
      allowed: false,
      newCount: session.message_count,
      remaining: rateLimitResult.remaining,
      reason: "hourly_limit",
    };
  }

  const updatedSession = await anonymousSessionsService.incrementMessageCount(
    session.id,
  );

  logger.debug("[Session] Incremented message count", {
    sessionId: session.id,
    newCount: updatedSession.message_count,
    remaining: session.messages_limit - updatedSession.message_count,
  });

  return {
    allowed: true,
    newCount: updatedSession.message_count,
    remaining: Math.max(
      0,
      session.messages_limit - updatedSession.message_count,
    ),
  };
}

/**
 * Migrate anonymous session to authenticated user
 *
 * Transfers:
 * - messageCount and metadata to org settings
 * - conversations
 * - characters
 * - room mappings
 */
export async function migrateAnonymousSession(
  anonymousUserId: string,
  privyUserId: string,
): Promise<{
  success: boolean;
  mergedData: {
    messageCount: number;
    conversationsTransferred: number;
    charactersTransferred: number;
    roomMappingsTransferred: number;
  };
}> {
  const logPrefix = "[Session:Migration]";

  logger.info(`${logPrefix} Starting migration`, {
    anonymousUserId,
    privyUserId,
  });

  const mergedData = {
    messageCount: 0,
    conversationsTransferred: 0,
    charactersTransferred: 0,
    roomMappingsTransferred: 0,
  };

  await db.transaction(async (tx) => {
    let [anonUser] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, anonymousUserId), eq(users.is_anonymous, true)))
      .limit(1);

    if (!anonUser) {
      [anonUser] = await tx
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, anonymousUserId),
            sql`${users.email} LIKE 'affiliate-%@anonymous.elizacloud.ai'`,
            sql`${users.privy_user_id} IS NULL`,
          ),
        )
        .limit(1);
    }

    if (!anonUser) {
      logger.warn(`${logPrefix} Anonymous user not found`, { anonymousUserId });
      throw new Error("Anonymous user not found");
    }

    const [anonSession] = await tx
      .select()
      .from(anonymousSessions)
      .where(eq(anonymousSessions.user_id, anonymousUserId))
      .limit(1);

    if (anonSession) {
      mergedData.messageCount = anonSession.message_count;
      logger.info(`${logPrefix} Found anonymous session data`, {
        messageCount: anonSession.message_count,
        tokensUsed: anonSession.total_tokens_used,
      });
    }

    const [realUser] = await tx
      .select()
      .from(users)
      .where(eq(users.privy_user_id, privyUserId))
      .limit(1);

    let targetUserId: string;
    let targetOrgId: string | null = null;

    if (!realUser) {
      const orgSlug = `user-${privyUserId.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`;

      const [organization] = await tx
        .insert(organizations)
        .values({
          name: `${anonUser.name || "User"}'s Organization`,
          slug: orgSlug,
          credit_balance: "5.00",
          settings: anonSession
            ? {
                migratedFromAnonymous: {
                  messageCount: anonSession.message_count,
                  tokensUsed: anonSession.total_tokens_used,
                  migratedAt: new Date().toISOString(),
                },
              }
            : {},
        })
        .returning();

      await tx
        .update(users)
        .set({
          privy_user_id: privyUserId,
          is_anonymous: false,
          anonymous_session_id: null,
          expires_at: null,
          organization_id: organization.id,
          role: "owner",
          updated_at: new Date(),
        })
        .where(eq(users.id, anonymousUserId));

      targetUserId = anonymousUserId;
      targetOrgId = organization.id;

      logger.info(`${logPrefix} Converted in-place`, {
        userId: targetUserId,
        orgId: targetOrgId,
      });

      const charResult = await tx
        .update(userCharacters)
        .set({
          organization_id: organization.id,
          updated_at: new Date(),
        })
        .where(eq(userCharacters.user_id, anonymousUserId))
        .returning({ id: userCharacters.id });

      mergedData.charactersTransferred = charResult.length;
    } else {
      if (!realUser.organization_id) {
        throw new Error(
          `Cannot migrate to user ${realUser.id} without organization`,
        );
      }

      targetUserId = realUser.id;
      targetOrgId = realUser.organization_id;

      const conversationResult = await tx
        .update(conversations)
        .set({
          user_id: realUser.id,
          organization_id: targetOrgId,
          updated_at: new Date(),
        })
        .where(eq(conversations.user_id, anonymousUserId))
        .returning();

      mergedData.conversationsTransferred = conversationResult.length;

      const charResult = await tx
        .update(userCharacters)
        .set({
          user_id: realUser.id,
          organization_id: targetOrgId,
          updated_at: new Date(),
        })
        .where(eq(userCharacters.user_id, anonymousUserId))
        .returning();

      mergedData.charactersTransferred = charResult.length;

      const roomCharResult = await tx
        .update(elizaRoomCharactersTable)
        .set({
          user_id: realUser.id,
          updated_at: new Date(),
        })
        .where(eq(elizaRoomCharactersTable.user_id, anonymousUserId))
        .returning();

      mergedData.roomMappingsTransferred = roomCharResult.length;

      // Update participants using Drizzle ORM (safer than raw SQL)
      await tx
        .update(participantTable)
        .set({ entityId: realUser.id })
        .where(eq(participantTable.entityId, anonymousUserId));

      if (anonSession && targetOrgId) {
        await tx
          .update(organizations)
          .set({
            settings: sql`COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({
              migratedFromAnonymous: {
                messageCount: anonSession.message_count,
                tokensUsed: anonSession.total_tokens_used,
                migratedAt: new Date().toISOString(),
              },
            })}::jsonb`,
          })
          .where(eq(organizations.id, targetOrgId));
      }

      await tx.delete(users).where(eq(users.id, anonymousUserId));

      logger.info(`${logPrefix} Transferred data to existing user`, {
        fromUserId: anonymousUserId,
        toUserId: targetUserId,
      });
    }

    if (anonSession) {
      await tx
        .update(anonymousSessions)
        .set({
          converted_at: new Date(),
          is_active: false,
        })
        .where(eq(anonymousSessions.id, anonSession.id));
    }
  });

  await clearSessionCookie();

  logger.info(`${logPrefix} Migration complete`, mergedData);

  return { success: true, mergedData };
}

/**
 * Check if anonymous user should be prompted to sign up
 */
export function shouldPromptSignup(sessionUser: SessionUser): {
  shouldPrompt: boolean;
  reason?: "message_limit_near" | "message_limit_reached" | "session_expiring";
} {
  if (!sessionUser.isAnonymous) {
    return { shouldPrompt: false };
  }

  if (sessionUser.messagesRemaining <= 0) {
    return { shouldPrompt: true, reason: "message_limit_reached" };
  }

  if (sessionUser.messagesRemaining <= 3) {
    return { shouldPrompt: true, reason: "message_limit_near" };
  }

  if (sessionUser.metadata.expiresAt) {
    const hoursRemaining =
      (sessionUser.metadata.expiresAt.getTime() - Date.now()) /
      (1000 * 60 * 60);
    if (hoursRemaining < 24) {
      return { shouldPrompt: true, reason: "session_expiring" };
    }
  }

  return { shouldPrompt: false };
}

/**
 * Get session summary for debugging
 */
export function getSessionDebugInfo(
  sessionUser: SessionUser,
): Record<string, unknown> {
  return {
    userId: sessionUser.userId,
    isAnonymous: sessionUser.isAnonymous,
    organizationId: sessionUser.organizationId,
    hasToken: !!sessionUser.sessionToken,
    tokenPreview: sessionUser.sessionToken?.slice(0, 8) + "...",
    messageCount: sessionUser.messageCount,
    messagesLimit: sessionUser.messagesLimit,
    messagesRemaining: sessionUser.messagesRemaining,
    createdAt: sessionUser.metadata.createdAt,
    expiresAt: sessionUser.metadata.expiresAt,
    hasSession: !!sessionUser.anonymousSession,
  };
}
