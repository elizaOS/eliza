/**
 * Anonymous Session Creator Service
 *
 * Shared logic for creating anonymous users and sessions.
 * Used by both the API route and lib/auth-anonymous.ts to avoid code duplication.
 */

import { dbWrite } from "@/db/client";
import { users } from "@/db/schemas";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { logger } from "@/lib/utils/logger";

export interface CreateAnonymousUserAndSessionParams {
  sessionToken: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  messagesLimit: number;
}

export interface CreateAnonymousUserAndSessionResult {
  newUser: typeof users.$inferSelect;
  newSession: Awaited<ReturnType<typeof anonymousSessionsService.create>>;
}

/**
 * Creates a new anonymous user and associated session.
 *
 * @param params - Session creation parameters
 * @returns The created user and session
 */
export async function createAnonymousUserAndSession(
  params: CreateAnonymousUserAndSessionParams,
): Promise<CreateAnonymousUserAndSessionResult> {
  const { sessionToken, expiresAt, ipAddress, userAgent, messagesLimit } = params;

  const [newUser] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `anonymous:${crypto.randomUUID()}`,
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
    ip_address: ipAddress,
    user_agent: userAgent,
    messages_limit: messagesLimit,
  });

  logger.info("[anonymous-session-creator] Created new anonymous user and session", {
    userId: newUser.id,
    sessionId: newSession.id,
    expiresAt,
  });

  return { newUser, newSession };
}
