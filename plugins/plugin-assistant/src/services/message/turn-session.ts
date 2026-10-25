/** Owns message response identity and terminal-event settlement across awaited and detached turn work. */

import type { IAgentRuntime, RoomHandlerLease, UUID } from "@elizaos/core";
import { trackPostDeliveryTask } from "@elizaos/core";

/**
 * Tracks the latest response ID per agent+room to handle message superseding
 */
export const latestResponseIds = new Map<string, Map<string, string[]>>();

export function clearLatestResponseId(
  agentId: UUID,
  roomId: UUID,
  responseId: UUID,
): void {
  const agentMap = latestResponseIds.get(agentId);
  if (!agentMap) {
    return;
  }

  const roomResponses = agentMap.get(roomId);
  if (!roomResponses) {
    return;
  }
  const responseIndex = roomResponses.lastIndexOf(responseId);
  if (responseIndex < 0) return;
  roomResponses.splice(responseIndex, 1);
  if (roomResponses.length === 0) agentMap.delete(roomId);
  if (agentMap.size === 0) {
    latestResponseIds.delete(agentId);
  }
}

export function getLatestResponseId(
  agentId: UUID,
  roomId: UUID,
): string | undefined {
  const roomResponses = latestResponseIds.get(agentId)?.get(roomId);
  return roomResponses?.[roomResponses.length - 1];
}

export function detachPostDeliverySideEffect(
  runtime: Pick<IAgentRuntime, "agentId" | "reportError">,
  label: string,
  task: () => Promise<unknown>,
  kind: "room-state" | "diagnostic" = "room-state",
  roomId?: string,
  roomHandlerLease?: RoomHandlerLease,
): Promise<void> {
  return trackPostDeliveryTask(
    runtime,
    label,
    task,
    kind === "diagnostic"
      ? { kind }
      : roomId && roomHandlerLease
        ? { kind, roomId, roomHandlerLease }
        : { kind },
  );
}
