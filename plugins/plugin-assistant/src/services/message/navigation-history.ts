/** Reads historical navigation evidence from host-owned outcomes on authorized
 * request memories. Delivery is a past transport fact, never current renderer
 * state or evidence of displayed records. No assistant prose supplies authority. */
import {
  type Action,
  ChannelType,
  conversationClientUserMemoryId,
  type EffectReceipt,
  hashStableJson,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  normalizeEffectReceipts,
  readDurableConversationChatMarker,
  type State,
  validateReadView,
} from "@elizaos/core";

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
  "resolvedAlias",
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
      receipt.resolvedAlias !== undefined &&
      (typeof receipt.resolvedAlias !== "string" ||
        !receipt.resolvedAlias.trim())
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

/** Retain only recorded, revision-bound Gmail continuation metadata, never body
 * text or a new grant. The caller has already verified the originating request.
 * Opaque reference spelling belongs to the provider; reads must reauthorize it. */
export function historicalGmailReadContinuations(
  results: Record<string, unknown>[],
  actions: readonly Action[] = [],
) {
  if (
    actions.filter((action) => action.name === "MESSAGE_READ_MESSAGE")
      .length !== 1
  )
    return [];
  const continuations: Array<{
    actionName: string;
    readView: ReturnType<typeof validateReadView>;
    control?: Record<string, unknown>;
  }> = [];
  for (const result of results) {
    if (result.success !== true || !isObjectRecord(result.data)) continue;
    const data = result.data,
      actionName = result.actionName ?? data.actionName;
    if (
      actionName !== "MESSAGE_READ_MESSAGE" ||
      (result.actionName !== undefined &&
        data.actionName !== undefined &&
        result.actionName !== data.actionName)
    )
      continue;
    try {
      const readView = validateReadView(data.readView),
        control = data.control;
      if (
        isObjectRecord(result.promptData) &&
        ((result.promptData.readView !== undefined &&
          hashStableJson(result.promptData.readView) !==
            hashStableJson(data.readView)) ||
          (result.promptData.control !== undefined &&
            hashStableJson(result.promptData.control) !==
              hashStableJson(control)))
      )
        continue;
      if (
        hashStableJson(data.readView) !== hashStableJson(readView) ||
        readView.reference.kind !== "email" ||
        readView.reference.resumability !== "restart-safe" ||
        (readView.reference.expiresAt !== undefined &&
          Date.parse(readView.reference.expiresAt) <= Date.now()) ||
        typeof readView.reference.revision !== "string" ||
        readView.reference.revision !== readView.slice.revision
      )
        continue;
      if (readView.slice.completeness === "complete" && control === undefined) {
        continuations.push({ actionName, readView });
        continue;
      }
      if (
        readView.slice.completeness !== "partial-recoverable" ||
        !isObjectRecord(control)
      )
        continue;
      if (
        Object.keys(control).sort().join(",") !==
          "action,expectedRevision,limit,offset,reference,source,unit" ||
        control.action !== "read_message" ||
        control.source !== "gmail" ||
        control.reference !== readView.reference.ref ||
        control.expectedRevision !== readView.reference.revision ||
        control.expectedRevision !== readView.slice.revision ||
        control.offset !== readView.slice.nextOffset ||
        control.unit !== readView.slice.range.unit ||
        !Number.isSafeInteger(control.limit) ||
        Number(control.limit) < 1 ||
        Number(control.limit) > 65536
      )
        continue;
      continuations.push({ actionName, readView, control: { ...control } });
    } catch {
      /* Invalid or conflicting history cannot supply a continuation. */
    }
  }
  return continuations;
}

/** Bind an omitted revision only to the newest exact stored continuation the
 * current owner has already named. Never creates work or substitutes a source. */
export function boundGmailContinuationRevision(input: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  reference: string | undefined;
  offset: number | undefined;
  limit: number | undefined;
  unit: string;
}): string | undefined {
  if (
    !input.reference ||
    !Number.isSafeInteger(input.offset) ||
    !input.offset ||
    !Number.isSafeInteger(input.limit) ||
    !input.limit
  )
    return;
  const provider = input.state?.data?.providers?.RECENT_MESSAGES;
  if (
    !isObjectRecord(provider) ||
    !isObjectRecord(provider.data) ||
    !Array.isArray(provider.data.recentMessages)
  )
    return;
  const reads: Array<{
    at: number;
    id: string;
    index: number;
    result: Record<string, unknown>;
  }> = [];
  for (const raw of provider.data.recentMessages) {
    if (
      !isObjectRecord(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.createdAt !== "number" ||
      !Number.isFinite(raw.createdAt)
    )
      continue;
    const memory = raw as unknown as Memory;
    const results = historicalActionResults(
      memory,
      input.message,
      input.runtime.agentId,
    );
    for (const [index, result] of results.entries()) {
      const data = isObjectRecord(result.data) ? result.data : undefined;
      const view =
        data && isObjectRecord(data.readView) ? data.readView : undefined;
      const reference =
        view && isObjectRecord(view.reference) ? view.reference : undefined;
      // Choose the latest named read before validating usability: an expired,
      // failed or complete newer read must never resurrect an older control.
      if (reference?.ref === input.reference)
        reads.push({ at: raw.createdAt, id: raw.id, index, result });
    }
  }
  if (!reads.length) return;
  const latest = Math.max(...reads.map((read) => read.at)),
    newest = reads.filter((read) => read.at === latest);
  if (new Set(newest.map((read) => read.id)).size !== 1) return;
  const lastIndex = Math.max(...newest.map((read) => read.index)),
    matches = newest.filter((read) => read.index === lastIndex);
  const revisions = new Set<string>();
  for (const read of matches) {
    const validated = historicalGmailReadContinuations(
      [read.result],
      input.runtime.actions ?? [],
    );
    if (validated.length !== 1) return;
    const control = validated[0].control;
    if (
      !control ||
      control.reference !== input.reference ||
      control.offset !== input.offset ||
      control.limit !== input.limit ||
      control.unit !== input.unit ||
      typeof control.expectedRevision !== "string"
    )
      return;
    revisions.add(control.expectedRevision);
  }
  return revisions.size === 1 ? [...revisions][0] : undefined;
}
