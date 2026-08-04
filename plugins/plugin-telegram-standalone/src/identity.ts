/** Durable Telegram sender resolution for the standalone production connector. */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { resolveTelegramRuntimeEntityId } from "@elizaos/plugin-telegram";

export async function resolveStandaloneTelegramEntityId(
  runtime: IAgentRuntime,
  accountId: string,
  telegramUserId: string
): Promise<UUID> {
  return resolveTelegramRuntimeEntityId(runtime, accountId, telegramUserId);
}
