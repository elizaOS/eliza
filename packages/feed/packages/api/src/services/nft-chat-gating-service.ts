import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  users,
} from "@feed/db";
import { generateSnowflakeId, logger, ValidationError } from "@feed/shared";
import { sql } from "drizzle-orm";
import { AuthorizationError, NotFoundError } from "../errors";
import {
  hasOnchainNftAccess,
  NftIndexerUnavailableError,
} from "./nft-indexer-service";

export interface NftChatGatingConfig {
  enabled: boolean;
  chatId: string | null;
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Returns the NFT chat gating configuration.
 */
export function getNftChatGatingConfig(): NftChatGatingConfig {
  const enabled = parseBooleanFlag(process.env.NFT_CHAT_GATING_ENABLED);
  const chatId = process.env.NFT_CHAT_GATING_CHAT_ID?.trim() || null;
  return { enabled, chatId };
}

function assertChatIdConfigured(config: NftChatGatingConfig): string {
  if (!config.enabled) {
    throw new ValidationError(
      "NFT chat gating is disabled",
      ["NFT_CHAT_GATING_ENABLED"],
      [{ field: "NFT_CHAT_GATING_ENABLED", message: "Flag is disabled" }],
    );
  }

  if (!config.chatId) {
    throw new ValidationError(
      "NFT chat gating chat id not configured",
      ["NFT_CHAT_GATING_CHAT_ID"],
      [
        {
          field: "NFT_CHAT_GATING_CHAT_ID",
          message: "Must be set when NFT chat gating is enabled",
        },
      ],
    );
  }

  return config.chatId;
}

export function isNftChatGatedChat(chatId: string): boolean {
  const { enabled, chatId: gatedChatId } = getNftChatGatingConfig();
  return enabled && gatedChatId !== null && chatId === gatedChatId;
}

async function hasPremiumChatHolderAccess(dbUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ walletAddress: users.walletAddress })
    .from(users)
    .where(eq(users.id, dbUserId))
    .limit(1);

  const walletAddress = row?.walletAddress ?? null;
  if (!walletAddress) return false;

  try {
    // Premium chat is holders-only. We keep negative TTL short to avoid
    // delaying access after a user acquires an NFT.
    return await hasOnchainNftAccess(walletAddress, {
      cacheScope: "premium_chat",
      positiveTtlMs: 10_000,
      negativeTtlMs: 10_000,
    });
  } catch (error: unknown) {
    // Fail closed if the indexer is unavailable/misconfigured.
    if (error instanceof NftIndexerUnavailableError) return false;
    throw error;
  }
}

export async function canAccessNftChatGate(
  dbUserId: string,
  chatId: string,
): Promise<boolean> {
  if (!isNftChatGatedChat(chatId)) return true;

  return hasPremiumChatHolderAccess(dbUserId);
}

export async function requireNftChatAccess(
  user: { userId: string; dbUserId?: string; isAgent?: boolean },
  chatId: string,
): Promise<void> {
  if (!isNftChatGatedChat(chatId)) return;

  // Prefer dbUserId for NFT access check (hasNftAccess expects database user ID).
  // Falls back to userId for backwards compatibility (userId === dbUserId when user exists in DB).
  const effectiveUserId = user.dbUserId ?? user.userId;
  const allowed = await canAccessNftChatGate(effectiveUserId, chatId);
  if (!allowed) {
    throw new AuthorizationError("NFT chat access required", "chat", "access", {
      chatId,
    });
  }
}

export async function ensureNftChatMembership(userId: string): Promise<{
  success: true;
  chatId: string;
}> {
  const config = getNftChatGatingConfig();
  const chatId = assertChatIdConfigured(config);

  const allowed = await hasPremiumChatHolderAccess(userId);

  if (!allowed) {
    throw new AuthorizationError("NFT chat access required", "chat", "join", {
      chatId,
    });
  }

  const [chat] = await db
    .select({ id: chats.id, isGroup: chats.isGroup, groupId: chats.groupId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);

  if (!chat) {
    throw new NotFoundError("Chat", chatId);
  }
  if (!chat.isGroup || !chat.groupId) {
    throw new ValidationError(
      "NFT gated chat is not a group chat",
      ["chatId"],
      [
        {
          field: "chatId",
          message: "Chat must be a group chat with a linked groupId",
        },
      ],
    );
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    const memberId = await generateSnowflakeId();
    await tx
      .insert(groupMembers)
      .values({
        id: memberId,
        groupId: chat.groupId!,
        userId,
        role: "member",
        addedBy: "system",
        joinedAt: now,
        isActive: true,
        messageCount: 0,
        qualityScore: 1.0,
      })
      .onConflictDoUpdate({
        target: [groupMembers.groupId, groupMembers.userId],
        set: {
          isActive: true,
          role: "member",
          addedBy: "system",
          joinedAt: now,
          kickedAt: sql`NULL`,
          kickReason: sql`NULL`,
        },
      });

    const participantId = await generateSnowflakeId();
    await tx
      .insert(chatParticipants)
      .values({
        id: participantId,
        chatId,
        userId,
        joinedAt: now,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [chatParticipants.chatId, chatParticipants.userId],
        set: {
          isActive: true,
          joinedAt: now,
        },
      });
  });

  logger.info(
    "Ensured NFT gated chat membership",
    { userId, chatId },
    "NFTChatGatingService",
  );

  return { success: true, chatId };
}

/**
 * Revoke NFT chat membership if the user no longer has NFT access.
 *
 * Note: PR4 introduces a best-effort reconciliation path via `GET /api/chats`
 * (grant/revoke on user activity). This remains useful as a targeted helper for
 * other entry points.
 */
export async function revokeNftChatMembershipIfNeeded(
  userId: string,
  chatId: string,
  reason: string,
): Promise<void> {
  if (!isNftChatGatedChat(chatId)) return;

  const allowed = await hasPremiumChatHolderAccess(userId);
  if (allowed) return;

  const [chat] = await db
    .select({ groupId: chats.groupId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);

  const groupId = chat?.groupId ?? null;

  await db.transaction(async (tx) => {
    await tx
      .update(chatParticipants)
      .set({ isActive: false })
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
          eq(chatParticipants.isActive, true),
        ),
      );

    if (groupId) {
      await tx
        .update(groupMembers)
        .set({
          isActive: false,
          kickedAt: new Date(),
          kickReason: reason,
        })
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.userId, userId),
            eq(groupMembers.isActive, true),
          ),
        );
    }
  });

  logger.info(
    "Revoked NFT gated chat membership",
    { userId, chatId, groupId, reason },
    "NFTChatGatingService",
  );
}

export async function reconcileNftChatMembershipForUser(user: {
  dbUserId: string;
  isAgent?: boolean;
}): Promise<
  | {
      status: "skipped";
      reason: "disabled" | "agent" | "missing_chat_id" | "error";
    }
  | { status: "noop"; allowed: boolean }
  | { status: "ensured"; chatId: string }
  | { status: "revoked"; chatId: string }
> {
  try {
    if (user.isAgent) return { status: "skipped", reason: "agent" };

    const config = getNftChatGatingConfig();
    if (!config.enabled) return { status: "skipped", reason: "disabled" };
    if (!config.chatId) return { status: "skipped", reason: "missing_chat_id" };

    const chatId = config.chatId;

    const allowed = await canAccessNftChatGate(user.dbUserId, chatId);

    // Check current membership state to avoid write-amplifying on every /api/chats call.
    const [chatRow] = await db
      .select({ groupId: chats.groupId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    const groupId = chatRow?.groupId ?? null;
    const [activeParticipant] = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, user.dbUserId),
          eq(chatParticipants.isActive, true),
        ),
      )
      .limit(1);

    const [activeMember] =
      groupId === null
        ? [undefined]
        : await db
            .select({ id: groupMembers.id })
            .from(groupMembers)
            .where(
              and(
                eq(groupMembers.groupId, groupId),
                eq(groupMembers.userId, user.dbUserId),
                eq(groupMembers.isActive, true),
              ),
            )
            .limit(1);

    const hasActiveMembership = Boolean(
      activeParticipant && (groupId ? activeMember : true),
    );

    if (allowed) {
      if (hasActiveMembership) return { status: "noop", allowed: true };
      await ensureNftChatMembership(user.dbUserId);
      return { status: "ensured", chatId };
    }

    if (!hasActiveMembership) return { status: "noop", allowed: false };

    await revokeNftChatMembershipIfNeeded(
      user.dbUserId,
      chatId,
      "NFT access revoked (ownership check)",
    );
    return { status: "revoked", chatId };
  } catch (error) {
    logger.warn(
      "Failed to reconcile NFT chat membership",
      { error, dbUserId: user.dbUserId },
      "NFTChatGatingService",
    );
    // Return safe noop to avoid accidental revocation on error
    return { status: "skipped", reason: "error" };
  }
}
