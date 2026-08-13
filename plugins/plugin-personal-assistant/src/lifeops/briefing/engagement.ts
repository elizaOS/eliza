/**
 * Persists structurally observed owner engagement with briefing items.
 * Action-completion payloads are treated as untrusted input: only successful,
 * core-normalized effect receipts from owner LifeOps and calendar actions may
 * be attributed to a recently rendered item with the same stable source ID.
 */

import {
  type ActionEventPayload,
  ElizaError,
  type IAgentRuntime,
} from "@elizaos/core";
import {
  type LifeOpsBriefItemEngagementRecord,
  type LifeOpsBriefItemEngagementWrite,
  LifeOpsRepository,
} from "../repository.js";
import type {
  LifeOpsBriefItemKind,
  LifeOpsBriefItemSource,
} from "./editorial-judgment.js";

const MAX_ATTRIBUTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SURFACED_DECISIONS = new Set(["lead", "include", "demote"]);
const BRIEF_ITEM_SOURCES = new Set<LifeOpsBriefItemSource>([
  "calendar",
  "inbox",
  "life",
  "money",
]);
const BRIEF_ITEM_KINDS = new Set<LifeOpsBriefItemKind>([
  "meeting",
  "message",
  "todo",
  "reminder",
  "habit",
  "goal",
  "recurring_charge",
]);

export type BriefEngagementProcessingResult =
  | {
      readonly status: "recorded";
      readonly records: readonly LifeOpsBriefItemEngagementRecord[];
    }
  | { readonly status: "ignored"; readonly reason: string }
  | { readonly status: "unmatched"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readIso(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = readString(record, key);
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function actionName(payload: ActionEventPayload): string | null {
  const actions = payload.content.actions;
  const first = Array.isArray(actions) ? actions[0] : null;
  return typeof first === "string" && first.trim().length > 0
    ? first.trim().toUpperCase()
    : null;
}

function actionResult(
  payload: ActionEventPayload,
): Record<string, unknown> | null {
  return asRecord(payload.content.actionResult);
}

function isSuccessfulResult(result: Record<string, unknown> | null): boolean {
  return result?.success === true;
}

function isOwnerOccurrenceAction(name: string): boolean {
  return (
    name === "LIFE" ||
    name === "OWNER_TODOS" ||
    name === "OWNER_REMINDERS" ||
    name === "OWNER_ROUTINES" ||
    name === "OWNER_ALARMS" ||
    name.startsWith("OWNER_TODOS_") ||
    name.startsWith("OWNER_REMINDERS_") ||
    name.startsWith("OWNER_ROUTINES_") ||
    name.startsWith("OWNER_ALARMS_")
  );
}

function isCalendarAction(name: string): boolean {
  return name === "CALENDAR" || name.startsWith("CALENDAR_");
}

function messageId(payload: ActionEventPayload): string | null {
  return typeof payload.messageId === "string" && payload.messageId.length > 0
    ? payload.messageId
    : null;
}

function parseBriefingRenderedWrites(
  runtime: IAgentRuntime,
  payload: ActionEventPayload,
): LifeOpsBriefItemEngagementWrite[] | null {
  const result = actionResult(payload);
  const data = asRecord(result?.data);
  const briefing = asRecord(data?.briefing);
  const editorial = asRecord(briefing?.editorial);
  const items = Array.isArray(editorial?.items) ? editorial.items : null;
  const decisions = Array.isArray(editorial?.decisions)
    ? editorial.decisions
    : null;
  const briefingId = readString(briefing, "id");
  const generatedAt = readIso(briefing, "generatedAt");
  if (!items || !decisions || !briefingId || !generatedAt) return null;

  const decisionsByItem = new Map<string, string>();
  for (const value of decisions) {
    const decision = asRecord(value);
    const itemId = readString(decision, "itemId");
    const decisionAction = readString(decision, "action");
    if (!itemId || !decisionAction) return null;
    decisionsByItem.set(itemId, decisionAction);
  }

  const writes: LifeOpsBriefItemEngagementWrite[] = [];
  for (const value of items) {
    const item = asRecord(value);
    const itemId = readString(item, "itemId");
    const source = readString(item, "source") as LifeOpsBriefItemSource | null;
    const kind = readString(item, "kind") as LifeOpsBriefItemKind | null;
    const sourceId = readString(item, "sourceId");
    const itemClass = readString(item, "itemClass");
    if (
      !itemId ||
      !source ||
      !BRIEF_ITEM_SOURCES.has(source) ||
      !kind ||
      !BRIEF_ITEM_KINDS.has(kind) ||
      !sourceId ||
      !itemClass ||
      itemId !== `${source}:${sourceId}`
    ) {
      return null;
    }
    if (!SURFACED_DECISIONS.has(decisionsByItem.get(itemId) ?? "")) continue;
    writes.push({
      agentId: runtime.agentId,
      briefingId,
      itemId,
      source,
      kind,
      sourceId,
      itemClass,
      eventType: "rendered",
      eventAt: generatedAt,
      weight: 1,
      metadata: {
        action: "BRIEF",
        decision: decisionsByItem.get(itemId),
        ...(messageId(payload) ? { messageId: messageId(payload) } : {}),
      },
    });
  }
  return writes;
}

async function persistRenderedBriefItems(args: {
  runtime: IAgentRuntime;
  payload: ActionEventPayload;
  repository: LifeOpsRepository;
}): Promise<BriefEngagementProcessingResult> {
  const writes = parseBriefingRenderedWrites(args.runtime, args.payload);
  if (!writes) {
    return { status: "rejected", reason: "Malformed briefing identity" };
  }
  if (writes.length === 0) {
    return { status: "ignored", reason: "Brief contained no surfaced items" };
  }
  return {
    status: "recorded",
    records: await args.repository.recordBriefItemEngagementsAtomic(writes),
  };
}

interface AppliedReceipt {
  readonly operation: string;
  readonly source: LifeOpsBriefItemSource;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly eventType: "completed" | "rescheduled";
  readonly receiptId: string;
}

function calendarTimesChanged(data: Record<string, unknown> | null): boolean {
  const event = asRecord(data?.event);
  const target = asRecord(data?.targetEvent);
  if (!event || !target) return false;
  const startAt = readIso(event, "startAt");
  const endAt = readIso(event, "endAt");
  const targetStartAt = readIso(target, "startAt");
  const targetEndAt = readIso(target, "endAt");
  return (
    Boolean(startAt && targetStartAt && startAt !== targetStartAt) ||
    Boolean(endAt && targetEndAt && endAt !== targetEndAt)
  );
}

function parseAppliedReceipt(args: {
  payload: ActionEventPayload;
  name: string;
  result: Record<string, unknown>;
}): AppliedReceipt | null {
  const receipts = Array.isArray(args.result.effectReceipts)
    ? args.result.effectReceipts
    : [];
  const data = asRecord(args.result.data);
  for (const value of receipts) {
    const receipt = asRecord(value);
    const resource = asRecord(receipt?.resource);
    const outcome = readString(receipt, "outcome");
    const operation = readString(receipt, "operation");
    const resourceKind = readString(resource, "kind");
    const sourceId = readString(resource, "id");
    const observedAt = readIso(receipt, "observedAt");
    const receiptId = readString(receipt, "receiptId");
    if (
      outcome !== "applied" ||
      !operation ||
      !sourceId ||
      !observedAt ||
      !receiptId
    ) {
      continue;
    }
    if (
      isOwnerOccurrenceAction(args.name) &&
      operation === "lifeops.occurrence.completed" &&
      resourceKind === "lifeops.occurrence"
    ) {
      return {
        operation,
        source: "life",
        sourceId,
        observedAt,
        eventType: "completed",
        receiptId,
      };
    }
    if (
      isCalendarAction(args.name) &&
      operation === "calendar.event.update" &&
      resourceKind === "calendar.event" &&
      calendarTimesChanged(data)
    ) {
      return {
        operation,
        source: "calendar",
        sourceId,
        observedAt,
        eventType: "rescheduled",
        receiptId,
      };
    }
  }
  return null;
}

async function persistAppliedEngagement(args: {
  runtime: IAgentRuntime;
  payload: ActionEventPayload;
  repository: LifeOpsRepository;
  name: string;
  result: Record<string, unknown>;
}): Promise<BriefEngagementProcessingResult> {
  const applied = parseAppliedReceipt(args);
  if (!applied) {
    return {
      status: "ignored",
      reason: "No supported applied engagement receipt",
    };
  }
  const sinceIso = new Date(
    Date.parse(applied.observedAt) - MAX_ATTRIBUTION_AGE_MS,
  ).toISOString();
  const rendered = await args.repository.findLatestRenderedBriefItem(
    args.runtime.agentId,
    {
      source: applied.source,
      sourceId: applied.sourceId,
      sinceIso,
      untilIso: applied.observedAt,
    },
  );
  if (!rendered) {
    return {
      status: "unmatched",
      reason: "No recent rendered item has the receipt resource identity",
    };
  }
  const record = await args.repository.recordBriefItemEngagement({
    agentId: rendered.agentId,
    briefingId: rendered.briefingId,
    itemId: rendered.itemId,
    source: rendered.source,
    kind: rendered.kind,
    sourceId: rendered.sourceId,
    itemClass: rendered.itemClass,
    eventType: applied.eventType,
    eventAt: applied.observedAt,
    weight: 1,
    metadata: {
      action: args.name,
      operation: applied.operation,
      receiptId: applied.receiptId,
      renderedEventId: rendered.id,
      ...(messageId(args.payload)
        ? { messageId: messageId(args.payload) }
        : {}),
    },
  });
  return { status: "recorded", records: [record] };
}

/** Process one action-completion payload at the post-settlement boundary. */
export async function processBriefEngagementActionCompleted(
  payload: ActionEventPayload,
  repository = new LifeOpsRepository(payload.runtime),
): Promise<BriefEngagementProcessingResult> {
  const name = actionName(payload);
  const result = actionResult(payload);
  if (!name || !result) {
    return { status: "rejected", reason: "Malformed action completion" };
  }
  if (!isSuccessfulResult(result)) {
    return { status: "ignored", reason: "Action did not succeed" };
  }
  if (name === "BRIEF") {
    return persistRenderedBriefItems({
      runtime: payload.runtime,
      payload,
      repository,
    });
  }
  if (!isOwnerOccurrenceAction(name) && !isCalendarAction(name)) {
    return { status: "ignored", reason: "Action cannot prove engagement" };
  }
  return persistAppliedEngagement({
    runtime: payload.runtime,
    payload,
    repository,
    name,
    result,
  });
}

/** Keep diagnostics failures observable without rewriting the settled action. */
export async function handleBriefEngagementActionCompleted(
  payload: ActionEventPayload,
  repository = new LifeOpsRepository(payload.runtime),
): Promise<void> {
  try {
    await processBriefEngagementActionCompleted(payload, repository);
  } catch (error) {
    // error-policy:J7 engagement diagnostics must not turn an already-settled
    // owner action into a failure, but the dropped signal remains observable.
    payload.runtime.reportError("BriefEngagement.actionCompleted", error, {
      action: actionName(payload),
      messageId: messageId(payload),
    });
    payload.runtime.logger.warn(
      {
        src: "brief-engagement",
        action: actionName(payload),
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to persist brief engagement",
    );
  }
}

/** Require an authoritative message timestamp for owner-facing control writes. */
export function requireBriefActionTimestamp(
  messageCreatedAt: number | undefined,
): string {
  if (
    messageCreatedAt === undefined ||
    !Number.isFinite(messageCreatedAt) ||
    messageCreatedAt <= 0
  ) {
    throw new ElizaError("[BRIEF] Missing action timestamp", {
      code: "BRIEF_ACTION_TIMESTAMP_REQUIRED",
      context: {},
      severity: "ephemeral",
    });
  }
  return new Date(messageCreatedAt).toISOString();
}
