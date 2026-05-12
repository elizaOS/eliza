/**
 * Session Management
 *
 * Anonymous session persistence, migration to Steward accounts, and limits.
 * Browser/session cookie creation for anonymous users is handled by the
 * Hono route at `apps/api/auth/anonymous-session`.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { AnonymousSession } from "@/db/schemas";
import {
  anonymousSessions,
  conversations,
  elizaRoomCharactersTable,
  organizations,
  userCharacters,
  users,
} from "@/db/schemas";
import { participantTable } from "@/db/schemas/eliza";
import { organizationConfig } from "@/db/schemas/organization-config";
import { userIdentities } from "@/db/schemas/user-identities";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import type { UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

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

/**
 * Increment message count for a session user
 */
export async function incrementSessionMessageCount(sessionUser: SessionUser): Promise<{
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

  const rateLimitResult = await anonymousSessionsService.checkRateLimit(session.id);
  if (!rateLimitResult.allowed) {
    return {
      allowed: false,
      newCount: session.message_count,
      remaining: rateLimitResult.remaining,
      reason: "hourly_limit",
    };
  }

  const updatedSession = await anonymousSessionsService.incrementMessageCount(session.id);

  logger.debug("[Session] Incremented message count", {
    sessionId: session.id,
    newCount: updatedSession.message_count,
    remaining: session.messages_limit - updatedSession.message_count,
  });

  return {
    allowed: true,
    newCount: updatedSession.message_count,
    remaining: Math.max(0, session.messages_limit - updatedSession.message_count),
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
  stewardUserId: string,
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
    stewardUserId,
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
      .innerJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .where(and(eq(users.id, anonymousUserId), eq(userIdentities.is_anonymous, true)))
      .limit(1)
      .then((rows) => rows.map((r) => r.users));

    if (!anonUser) {
      [anonUser] = await tx
        .select()
        .from(users)
        .leftJoin(userIdentities, eq(users.id, userIdentities.user_id))
        .where(
          and(
            eq(users.id, anonymousUserId),
            sql`${users.email} LIKE 'affiliate-%@anonymous.elizacloud.ai'`,
            eq(users.is_anonymous, true),
          ),
        )
        .limit(1)
        .then((rows) => rows.map((r) => r.users));
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
      .innerJoin(userIdentities, eq(users.id, userIdentities.user_id))
      .where(eq(userIdentities.steward_user_id, stewardUserId))
      .limit(1)
      .then((rows) => rows.map((r) => r.users));

    let targetUserId: string;
    let targetOrgId: string | null = null;

    if (!realUser) {
      const orgSlug = `user-${stewardUserId.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`;

      const [organization] = await tx
        .insert(organizations)
        .values({
          name: `${anonUser.name || "User"}'s Organization`,
          slug: orgSlug,
          credit_balance: "5.00",
        })
        .returning();

      // Store migration metadata in organization config
      if (anonSession) {
        await tx.insert(organizationConfig).values({
          organization_id: organization.id,
          settings: {
            migratedFromAnonymous: {
              messageCount: anonSession.message_count,
              tokensUsed: anonSession.total_tokens_used,
              migratedAt: new Date().toISOString(),
            },
          },
        });
      }

      // Update identity to non-anonymous
      await tx
        .update(userIdentities)
        .set({
          steward_user_id: stewardUserId,
          is_anonymous: false,
          anonymous_session_id: null,
          expires_at: null,
          updated_at: new Date(),
        })
        .where(eq(userIdentities.user_id, anonymousUserId));

      await tx
        .update(users)
        .set({
          steward_user_id: stewardUserId,
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
        throw new Error(`Cannot migrate to user ${realUser.id} without organization`);
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
        // Store migration metadata in organization config
        const existingConfig = await tx.query.organizationConfig.findFirst({
          where: eq(organizationConfig.organization_id, targetOrgId),
        });
        if (existingConfig) {
          await tx
            .update(organizationConfig)
            .set({
              settings: sql`COALESCE(${organizationConfig.settings}, '{}'::jsonb) || ${JSON.stringify(
                {
                  migratedFromAnonymous: {
                    messageCount: anonSession.message_count,
                    tokensUsed: anonSession.total_tokens_used,
                    migratedAt: new Date().toISOString(),
                  },
                },
              )}::jsonb`,
            })
            .where(eq(organizationConfig.organization_id, targetOrgId));
        } else {
          await tx.insert(organizationConfig).values({
            organization_id: targetOrgId,
            settings: {
              migratedFromAnonymous: {
                messageCount: anonSession.message_count,
                tokensUsed: anonSession.total_tokens_used,
                migratedAt: new Date().toISOString(),
              },
            },
          });
        }
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
      (sessionUser.metadata.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursRemaining < 24) {
      return { shouldPrompt: true, reason: "session_expiring" };
    }
  }

  return { shouldPrompt: false };
}

/**
 * Get session summary for debugging
 */
export function getSessionDebugInfo(sessionUser: SessionUser): Record<string, unknown> {
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
