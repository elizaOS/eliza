/** Durable Telegram sender resolution for the standalone production connector. */
import {
  createUniqueUuid,
  ElizaError,
  type Entity,
  getConfiguredOwnerEntityIds,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function resolveStandaloneTelegramEntityId(
  runtime: IAgentRuntime,
  accountId: string,
  telegramUserId: string
): Promise<UUID> {
  const ownerIds = getConfiguredOwnerEntityIds(runtime);
  if (ownerIds.length === 0) {
    return createUniqueUuid(runtime, `telegram:${accountId}:user:${telegramUserId}`) as UUID;
  }
  if (typeof runtime.getEntityById !== "function") {
    throw new ElizaError("Telegram identity store is not ready", {
      code: "TELEGRAM_IDENTITY_NOT_READY",
      context: { accountId, telegramUserId },
    });
  }

  for (const ownerId of ownerIds) {
    const owner = (await runtime.getEntityById(ownerId as UUID)) as Entity | null;
    const telegram = asRecord(asRecord(owner?.metadata)?.telegram);
    const boundId = telegram?.userId ?? telegram?.id;
    const boundAccount = telegram?.accountId;
    if (
      String(boundId ?? "") === telegramUserId &&
      (boundAccount === undefined || String(boundAccount) === accountId)
    ) {
      return ownerId as UUID;
    }
  }

  return createUniqueUuid(runtime, `telegram:${accountId}:user:${telegramUserId}`) as UUID;
}
