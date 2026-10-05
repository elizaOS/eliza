/** Resolves one Telegram sender identity and its owner/admin authority for inbound dispatch. */
import {
  createUniqueUuid,
  hasRoleAccess,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import type { Context } from "telegraf";
import { resolveTelegramRuntimeEntityId } from "./identity";

const DEFAULT_ACCOUNT_ID = "default";
const TELEGRAM_SURFACE = "telegram";
export interface TelegramSenderAuth {
  isAuthorized: boolean;
  isElevated: boolean;
  senderName?: string;
  entityId?: UUID;
}

/**
 * Account-scoped key matching `MessageManager.scopedTelegramKey` for rooms and
 * chats. Sender entity ids go through `resolveTelegramRuntimeEntityId` instead
 * so slash-command auth uses the same UUID inbound messages persist.
 */
function scopedTelegramKey(key: string, accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? key : `${accountId}:${key}`;
}

/**
 * Resolve the Telegram sender's trust level using the agent's role model — the
 * same `hasRoleAccess` check every surface runs. OWNER access satisfies
 * `requiresAuth`; ADMIN access satisfies `requiresElevated`. The sender's
 * Telegram user id is mapped through `resolveTelegramRuntimeEntityId`
 * (matching inbound `handleMessage`), so role resolution reads the
 * canonical-owner / world-role state the inbound pipeline established.
 * The resolved entity is returned with the auth result and must be reused
 * for dispatch — never looked up again after the role check awaits.
 */
export async function resolveTelegramSenderAuth(
  ctx: Context,
  runtime: IAgentRuntime,
  accountId: string,
): Promise<TelegramSenderAuth> {
  const fromId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (fromId === undefined || chatId === undefined) {
    // No identity to resolve — fail closed.
    return { isAuthorized: false, isElevated: false };
  }

  const entityId = await resolveTelegramRuntimeEntityId(
    runtime,
    accountId,
    String(fromId),
  );
  const roomId = createUniqueUuid(
    runtime,
    scopedTelegramKey(String(chatId), accountId),
  ) as UUID;

  const memory: Memory = {
    id: createUniqueUuid(runtime, `${chatId}-${fromId}-cmd`) as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: { text: "/whoami", source: TELEGRAM_SURFACE },
    createdAt: Date.now(),
  };

  const [isOwner, isAdmin] = await Promise.all([
    hasRoleAccess(runtime, memory, "OWNER"),
    hasRoleAccess(runtime, memory, "ADMIN"),
  ]);

  const senderName =
    ctx.from?.username ?? ctx.from?.first_name ?? String(fromId);
  return {
    isAuthorized: isOwner,
    isElevated: isAdmin,
    senderName,
    entityId,
  };
}
