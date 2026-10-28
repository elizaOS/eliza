/** Current terminal states for exact historical proposals. Never dispatches or
 * resolves an approval. Original request and preview receipt bytes are retained. */
import {
  type ContextEvent,
  type ContextObjectPromptSegment,
  HISTORICAL_EFFECT_TERMINALS,
  type HistoricalEffectTerminal,
  hashStableJson,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  normalizeEffectReceipt,
  normalizeEffectReceipts,
  revalidateOwnerExclusiveDisclosure,
} from "@elizaos/core";
import { readApprovalRequestsForOriginalSources } from "../approval/store.ts";
import { validateDevicePayload } from "../device-actions/contract.ts";
import { deviceActionEffectReceipts } from "../device-actions/effect-receipts.ts";
import { resolveStage1SenderRole } from "./addressing.ts";
import {
  historicalActionResults,
  historicalReceiptGroups,
} from "./navigation-history.ts";

type ContextSegmentEvent = Extract<
  ContextEvent,
  { segment: ContextObjectPromptSegment }
>;

type Reference = {
  proposalId: string;
  requestMessageId: string;
  event: ContextSegmentEvent;
  receipt: ReturnType<typeof normalizeEffectReceipt>;
  actionName: string;
};
const scopeValid = (runtime: IAgentRuntime, message: Memory) =>
  message.agentId === runtime.agentId &&
  typeof message.roomId === "string" &&
  typeof message.entityId === "string" &&
  message.entityId !== runtime.agentId;

/** Cost: one exact-pair approval SELECT and two owner checks; no per-item reads,
 * model calls, source writes, queue transitions, or provider calls. Background
 * review uses its existing OWNER-role scope and never publishes these proofs. */
export async function reconcileHistoricalProposalTerminals(
  runtime: IAgentRuntime,
  message: Memory,
  events: readonly ContextEvent[],
  originals: readonly Memory[],
  options: { background?: boolean } = {},
): Promise<ContextEvent[]> {
  const unchanged = () => [...events];
  if (!scopeValid(runtime, message)) return unchanged();
  const agentId = runtime.agentId,
    roomId = message.roomId,
    entityId = message.entityId;
  const allowed = async () => {
    if (
      !scopeValid(runtime, message) ||
      runtime.agentId !== agentId ||
      message.roomId !== roomId ||
      message.entityId !== entityId
    )
      return false;
    try {
      if (options.background)
        return (await resolveStage1SenderRole(runtime, message)) === "OWNER";
      const access = await revalidateOwnerExclusiveDisclosure(runtime, message);
      return (
        access.allowed && access.audience.canonicalOwnerEntityId === entityId
      );
    } catch {
      return false;
    }
  };
  const sources = new Map<string, Memory | undefined>();
  for (const source of originals)
    if (source.id)
      sources.set(source.id, sources.has(source.id) ? undefined : source);
  const references: Reference[] = [];
  for (const event of events) {
    if (
      event.type !== "segment" ||
      !("segment" in event) ||
      !isObjectRecord(event.segment) ||
      typeof event.segment.content !== "string" ||
      event.source !== "message-service" ||
      event.segment.label !== "runtime:historical_effects" ||
      event.id !== event.segment.id
    )
      continue;
    let value: unknown;
    try {
      value = JSON.parse(event.segment.content);
    } catch {
      continue;
    }
    if (
      !isObjectRecord(value) ||
      typeof value.requestSourceEventId !== "string" ||
      !value.requestSourceEventId.startsWith("history:") ||
      !Array.isArray(value.outcomes)
    )
      continue;
    const original = sources.get(value.requestSourceEventId.slice(8));
    if (!original?.id) continue;
    const originalResults = historicalActionResults(
      original,
      message,
      agentId,
    ).filter((result) => {
      try {
        return (
          hashStableJson(result.effectReceipts) ===
          hashStableJson(normalizeEffectReceipts(result.effectReceipts))
        );
      } catch {
        return false;
      }
    });
    const canonical = historicalReceiptGroups(
      originalResults,
      runtime.actions ?? [],
    ).effects;
    for (const outcome of value.outcomes) {
      if (
        !isObjectRecord(outcome) ||
        outcome.success !== true ||
        typeof outcome.actionName !== "string"
      )
        continue;
      let receipt: ReturnType<typeof normalizeEffectReceipt>;
      try {
        receipt = normalizeEffectReceipt(outcome.receipt);
      } catch {
        continue;
      }
      if (
        receipt.outcome !== "preview" ||
        receipt.resource.kind !== "device.approval" ||
        receipt.resource.id !== receipt.receiptId ||
        !receipt.operation.startsWith("device.") ||
        !receipt.idempotency.key
      )
        continue;
      if (
        !canonical.some(
          (row) =>
            row.actionName === outcome.actionName &&
            row.success === outcome.success &&
            hashStableJson(row.receipt) === hashStableJson(receipt),
        )
      )
        continue;
      references.push({
        proposalId: receipt.receiptId,
        requestMessageId: original.id,
        event: event as ContextSegmentEvent,
        receipt,
        actionName: outcome.actionName,
      });
    }
  }
  if (!references.length || !(await allowed())) return unchanged();
  let rows;
  try {
    rows = await readApprovalRequestsForOriginalSources(runtime, references);
  } catch {
    return unchanged();
  }
  if (!(await allowed())) return unchanged();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const proofs = new Map<ContextSegmentEvent, HistoricalEffectTerminal[]>(),
    terminals: ContextEvent[] = [];
  for (const ref of references) {
    const row = byId.get(ref.proposalId);
    if (
      !row ||
      row.requestedBy !== agentId ||
      row.action !== "device_action" ||
      !["done", "rejected", "expired"].includes(row.state) ||
      row.idempotencyKey !== ref.receipt.idempotency.key
    )
      continue;
    let payload, receipt;
    try {
      payload = validateDevicePayload(row.payload);
      if (
        payload.workflow ||
        payload.requestMessageId !== ref.requestMessageId ||
        "device." + payload.operation.type !== ref.receipt.operation
      )
        continue;
      if (
        row.state === "done" &&
        (!row.execution || row.execution.providerReceipt?.outcome !== "applied")
      )
        continue;
      const effects = deviceActionEffectReceipts({
        request: row,
        reused: true,
      });
      if (effects.length !== 1) continue;
      receipt = normalizeEffectReceipt({
        ...effects[0],
        observedAt: row.updatedAt.toISOString(),
      });
    } catch {
      continue;
    }
    const proof: HistoricalEffectTerminal = {
      requestSourceEventId: "history:" + ref.requestMessageId,
      originalReceiptHash: hashStableJson(ref.receipt),
      terminalReceipt: receipt,
      state: row.state as HistoricalEffectTerminal["state"],
    };
    const list = proofs.get(ref.event) ?? [];
    list.push(proof);
    proofs.set(ref.event, list);
    const id = "historical-proposal-terminal:" + row.id;
    terminals.push({
      id,
      type: "segment",
      source: "message-service",
      createdAt: row.updatedAt.getTime(),
      segment: {
        id,
        label: "runtime:historical_effects",
        stable: false,
        content: JSON.stringify({
          requestSourceEventId: proof.requestSourceEventId,
          scope: `Authoritative later proposal state: ${row.state}. This supersedes the earlier preview of proposal ${row.id} only; it grants no new authority and is not a current record read. Original request and preview remain in saved history.`,
          outcomes: [
            {
              actionName: ref.actionName,
              success: row.state === "done",
              receipt,
            },
          ],
        }),
      },
      [HISTORICAL_EFFECT_TERMINALS]: [proof],
    } as ContextSegmentEvent);
  }
  if (!proofs.size) return unchanged();
  return [
    ...events.map((event) =>
      proofs.has(event as ContextSegmentEvent)
        ? {
            ...event,
            [HISTORICAL_EFFECT_TERMINALS]: proofs.get(
              event as ContextSegmentEvent,
            ),
          }
        : event,
    ),
    ...terminals,
  ];
}
