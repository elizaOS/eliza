/**
 * Response Tracking Utilities
 *
 * Manages response ID tracking to prevent race conditions when multiple
 * messages are being processed simultaneously.
 */

import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";

/**
 * Builds cache key for response tracking.
 *
 * @param agentId - Agent UUID.
 * @param roomId - Room ID.
 * @returns Cache key string.
 */
export function buildResponseCacheKey(agentId: UUID, roomId: string): string {
  return `response_id:${agentId}:${roomId}`;
}

/**
 * Gets the latest response ID for a room.
 *
 * @param runtime - Agent runtime instance.
 * @param roomId - Room ID.
 * @returns Latest response ID or null if not found.
 */
export async function getLatestResponseId(
  runtime: IAgentRuntime,
  roomId: string,
): Promise<string | null> {
  const key = buildResponseCacheKey(runtime.agentId, roomId);
  return (await runtime.getCache<string>(key)) ?? null;
}

/**
 * Sets the latest response ID for a room.
 *
 * @param runtime - Agent runtime instance.
 * @param roomId - Room ID.
 * @param responseId - Response ID to set.
 */
export async function setLatestResponseId(
  runtime: IAgentRuntime,
  roomId: string,
  responseId: string,
): Promise<void> {
  if (!responseId || typeof responseId !== "string") {
    logger.error("[setLatestResponseId] Invalid responseId:", responseId);
    throw new Error(`Invalid responseId: ${responseId}`);
  }

  const key = buildResponseCacheKey(runtime.agentId, roomId);
  logger.debug(
    `[setLatestResponseId] Setting cache: ${key}, responseId: ${responseId.substring(0, 8)}`,
  );

  await runtime.setCache(key, responseId);
}

/**
 * Clears the latest response ID for a room.
 *
 * @param runtime - Agent runtime instance.
 * @param roomId - Room ID.
 */
export async function clearLatestResponseId(runtime: IAgentRuntime, roomId: string): Promise<void> {
  const key = buildResponseCacheKey(runtime.agentId, roomId);
  logger.debug(`[clearLatestResponseId] Deleting cache key: ${key}`);
  await runtime.deleteCache(key);
}

/**
 * Checks if a response is still valid (not superseded by a newer message).
 *
 * @param runtime - Agent runtime instance.
 * @param roomId - Room ID.
 * @param responseId - Response ID to check.
 * @returns True if response is still valid.
 */
export async function isResponseStillValid(
  runtime: IAgentRuntime,
  roomId: string,
  responseId: string,
): Promise<boolean> {
  const currentResponseId = await getLatestResponseId(runtime, roomId);
  return currentResponseId === responseId;
}
