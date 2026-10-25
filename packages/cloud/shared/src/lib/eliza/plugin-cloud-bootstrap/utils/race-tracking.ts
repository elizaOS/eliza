// Wires hosted Eliza agent race tracking behavior for cloud runtime services.
import { cache } from "../../../cache/client";

const RESPONSE_ID_TTL_SECONDS = 60 * 60;
const localLatestResponseIds = new Map<string, Map<string, string>>();

function raceKey(agentId: string, roomId: string): string {
  return `cloud-bootstrap:latest-response:${agentId}:${roomId}`;
}

function getLocalResponseId(agentId: string, roomId: string): string | undefined {
  return localLatestResponseIds.get(agentId)?.get(roomId);
}

function setLocalResponseId(agentId: string, roomId: string, responseId: string): void {
  let inner = localLatestResponseIds.get(agentId);
  if (!inner) {
    inner = new Map<string, string>();
    localLatestResponseIds.set(agentId, inner);
  }
  inner.set(roomId, responseId);
}

function clearLocalResponseId(agentId: string, roomId: string): void {
  const agentResponses = localLatestResponseIds.get(agentId);
  if (!agentResponses) {
    return;
  }

  agentResponses.delete(roomId);
  if (agentResponses.size === 0) {
    localLatestResponseIds.delete(agentId);
  }
}

export async function setLatestResponseId(
  agentId: string,
  roomId: string,
  responseId: string,
): Promise<void> {
  setLocalResponseId(agentId, roomId, responseId);
  await cache.set(raceKey(agentId, roomId), responseId, RESPONSE_ID_TTL_SECONDS);
}

export async function getLatestResponseId(
  agentId: string,
  roomId: string,
): Promise<string | undefined> {
  const cachedResponseId = await cache.get<string>(raceKey(agentId, roomId));
  if (typeof cachedResponseId === "string" && cachedResponseId.length > 0) {
    setLocalResponseId(agentId, roomId, cachedResponseId);
    return cachedResponseId;
  }

  return getLocalResponseId(agentId, roomId);
}

export async function isLatestResponseId(
  agentId: string,
  roomId: string,
  responseId: string,
): Promise<boolean> {
  return (await getLatestResponseId(agentId, roomId)) === responseId;
}

export async function cleanupLatestResponseId(
  agentId: string,
  roomId: string,
  responseId?: string,
): Promise<void> {
  const currentResponseId = await getLatestResponseId(agentId, roomId);
  if (responseId && currentResponseId !== responseId) {
    return;
  }

  clearLocalResponseId(agentId, roomId);
  await cache.del(raceKey(agentId, roomId));
}

export function resetLatestResponseIdsForTests(): void {
  localLatestResponseIds.clear();
}
