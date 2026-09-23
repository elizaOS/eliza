/** Reads historical navigation evidence from host-owned outcomes on authorized
 * request memories. Delivery is a past transport fact, never current renderer
 * state or evidence of displayed records. No assistant prose supplies authority. */
import { ChannelType, isObjectRecord, type Memory } from "@elizaos/core";
import {
  conversationClientUserMemoryId,
  readDurableConversationChatMarker,
} from "@elizaos/shared/conversation-chat-marker";

const NAVIGATION_FIELDS = new Set([
  "effect",
  "stepId",
  "viewId",
  "status",
  "reason",
  "handoffId",
  "label",
  "subview",
  "path",
]);

export function historicalNavigationReceipts(
  request: Memory,
  current: Memory,
  agentId: string,
): { success: boolean; receipt: string }[] {
  if (
    request.id === current.id ||
    request.agentId !== agentId ||
    request.roomId !== current.roomId ||
    request.entityId !== current.entityId ||
    request.entityId === agentId ||
    request.content.source !== "client_chat" ||
    (request.content.channelType !== ChannelType.DM &&
      request.content.channelType !== ChannelType.VOICE_DM)
  )
    return [];
  const marker = readDurableConversationChatMarker(
    request.content.chatIdempotency,
  );
  const scope = `${agentId}:${current.roomId}:${current.entityId}`;
  if (
    !marker ||
    marker.scope !== scope ||
    conversationClientUserMemoryId(scope, marker.clientMessageId) !==
      request.id ||
    marker.outcomeJson === undefined
  )
    return [];
  let outcome: unknown;
  try {
    outcome = JSON.parse(marker.outcomeJson);
  } catch {
    // error-policy:J3 Invalid persisted outcomes cannot supply historical evidence.
    return [];
  }
  if (
    !isObjectRecord(outcome) ||
    outcome.userMessageId !== request.id ||
    !Array.isArray(outcome.actionResults)
  )
    return [];
  const receipts: { success: boolean; receipt: string }[] = [];
  for (const result of outcome.actionResults) {
    if (
      !isObjectRecord(result) ||
      (result.actionName !== "VIEWS_SHOW" && result.actionName !== "VIEWS") ||
      typeof result.success !== "boolean" ||
      typeof result.text !== "string"
    )
      continue;
    let receipt: unknown;
    try {
      receipt = JSON.parse(result.text);
    } catch {
      // error-policy:J3 Ordinary action prose is not a navigation receipt.
      continue;
    }
    if (
      !isObjectRecord(receipt) ||
      receipt.effect !== "view_navigation" ||
      typeof receipt.status !== "string" ||
      !(typeof receipt.viewId === "string" || receipt.viewId === null) ||
      !(typeof receipt.stepId === "string" || receipt.stepId === null) ||
      Object.entries(receipt).some(
        ([key, value]) =>
          !NAVIGATION_FIELDS.has(key) ||
          (typeof value !== "string" && value !== null),
      )
    )
      continue;
    if (
      receipt.status === "delivered" &&
      (result.success !== true ||
        typeof receipt.handoffId !== "string" ||
        !isObjectRecord(result.values) ||
        result.values.completedActionDelivered !== true ||
        result.values.completedActionHandoffId !== receipt.handoffId)
    )
      continue;
    receipts.push({ success: result.success, receipt: result.text });
  }
  return receipts;
}
