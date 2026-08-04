/**
 * Telegram sender identity resolution against the canonical owner entity.
 * Owner pairing writes the verified Telegram id into the owner entity metadata;
 * inbound production paths read that durable row before deriving a connector
 * entity so a restart cannot split the owner into a fresh platform UUID.
 */
import {
  createUniqueUuid,
  ElizaError,
  type Entity,
  getConfiguredOwnerEntityIds,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";

export function telegramIdentityMetadata(
  telegramUserId: string,
  name?: string,
  username?: string,
  accountId?: string,
): Record<string, string> {
  return {
    userId: telegramUserId,
    id: telegramUserId,
    ...(name ? { name } : {}),
    ...(username ? { username } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function metadataRecord(
  entity: Entity | null | undefined,
): Record<string, unknown> | null {
  const metadata = entity?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function connectorRecord(
  entity: Entity | null | undefined,
): Record<string, unknown> | null {
  const telegram = metadataRecord(entity)?.telegram;
  return telegram && typeof telegram === "object" && !Array.isArray(telegram)
    ? (telegram as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function telegramOwnerMatches(
  entity: Entity | null | undefined,
  telegramUserId: string,
  accountId: string,
): boolean {
  const telegram = connectorRecord(entity);
  if (!telegram) return false;
  const id = stringField(telegram.userId) ?? stringField(telegram.id);
  if (id !== telegramUserId) return false;
  const boundAccountId = stringField(telegram.accountId);
  // Older owner-pairing rows predate account-scoped metadata. The Telegram
  // user id is server-attested, so those rows remain valid for the runtime's
  // owner while newly written rows bind to the specific bot account.
  return !boundAccountId || boundAccountId === accountId;
}

export async function resolveTelegramRuntimeEntityId(
  runtime: IAgentRuntime,
  accountId: string,
  telegramUserId: string,
): Promise<UUID> {
  const ownerIds = getConfiguredOwnerEntityIds(runtime);
  if (ownerIds.length === 0) {
    return createUniqueUuid(runtime, `${accountId}:${telegramUserId}`) as UUID;
  }
  if (typeof runtime.getEntityById !== "function") {
    throw new ElizaError("Telegram identity store is not ready", {
      code: "TELEGRAM_IDENTITY_NOT_READY",
      context: { accountId, telegramUserId },
    });
  }

  for (const ownerId of ownerIds) {
    const owner = await runtime.getEntityById(ownerId as UUID);
    if (telegramOwnerMatches(owner, telegramUserId, accountId)) {
      return ownerId as UUID;
    }
  }

  // `getEntityById` throws on storage failure; a null owner here means the
  // configured owner is not paired to this Telegram user yet, not that the row
  // failed to load.
  return createUniqueUuid(runtime, `${accountId}:${telegramUserId}`) as UUID;
}
