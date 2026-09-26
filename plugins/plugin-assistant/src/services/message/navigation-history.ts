/** Reads historical navigation evidence from host-owned outcomes on authorized
 * request memories. Delivery is a past transport fact, never current renderer
 * state or evidence of displayed records. No assistant prose supplies authority. */
import {
  type Action,
  ChannelType,
  type EffectReceipt,
  hashStableJson,
  isObjectRecord,
  type Memory,
  normalizeEffectReceipts,
} from "@elizaos/core";
import {
  conversationClientUserMemoryId,
  readDurableConversationChatMarker,
} from "@elizaos/core/conversation-chat-marker";

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

export function historicalActionResults(
  request: Memory,
  current: Memory,
  agentId: string,
): Record<string, unknown>[] {
  if (
    request.id === current.id ||
    current.agentId !== agentId ||
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
  return outcome.actionResults.filter(isObjectRecord);
}

/** Partition only owner-declared exact read operations; generic noops are not reads. */
export function historicalReceiptGroups(
  results: Record<string, unknown>[],
  actions: readonly Action[] = [],
) {
  type Outcome = {
    actionName: string | undefined;
    success: boolean;
    receipt: EffectReceipt;
  };
  const effects: Outcome[] = [];
  const observations: Outcome[] = [];
  const registered = new Map<string, Action | undefined>();
  for (const action of actions)
    registered.set(
      action.name,
      registered.has(action.name) ? undefined : action,
    );
  for (const result of results) {
    if (typeof result.success !== "boolean") continue;
    try {
      const receipts = normalizeEffectReceipts(result.effectReceipts);
      const actionName =
        typeof result.actionName === "string" ? result.actionName : undefined;
      const declared = actionName
        ? registered.get(actionName)?.historicalObservationOperations
        : undefined;
      // Normalization deliberately scrubs unknown fields and deduplicates IDs.
      // JSONB may reorder object keys, so compare canonical values structurally;
      // arrays, extra fields, duplicate IDs and value coercions still matter.
      // Unsafe evidence stays in the normalized inline effects lane.
      const canonical =
        hashStableJson(result.effectReceipts) === hashStableJson(receipts);
      for (const receipt of receipts) {
        const outcome = { actionName, success: result.success, receipt };
        if (
          canonical &&
          result.success &&
          Array.isArray(declared) &&
          declared.includes(receipt.operation) &&
          receipt.outcome === "noop" &&
          receipt.idempotency.replayed === false
        )
          observations.push(outcome);
        else effects.push(outcome);
      }
    } catch {
      // error-policy:J3 Preserve existing rejection of malformed stored receipts.
      // Raw unknown payload fields must not bypass core receipt normalization.
    }
  }
  return { effects, observations };
}

export function historicalNavigationReceipts(
  results: Record<string, unknown>[],
): { success: boolean; receipt: string }[] {
  const receipts: { success: boolean; receipt: string }[] = [];
  for (const result of results) {
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
