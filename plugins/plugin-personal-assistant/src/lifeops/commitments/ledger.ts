/**
 * Durable commitment and obligation ledger primitives for LifeOps. Connector
 * and document ingestion code can write normalized rows here, while brief and
 * prioritization paths can audit the same records for orphaned promises,
 * renewal/filing deadlines, and "what will I regret" queries.
 */
import crypto from "node:crypto";
import { ElizaError } from "@elizaos/core";

export const LIFEOPS_COMMITMENT_SOURCES = [
  "sent_mail",
  "transcript",
  "chat",
  "document",
] as const;

export type LifeOpsCommitmentSource =
  (typeof LIFEOPS_COMMITMENT_SOURCES)[number];

export const LIFEOPS_COMMITMENT_KINDS = [
  "commitment",
  "renewal",
  "filing",
  "warranty",
] as const;

export type LifeOpsCommitmentKind = (typeof LIFEOPS_COMMITMENT_KINDS)[number];

export const LIFEOPS_COMMITMENT_STATUSES = [
  "open",
  "tracked",
  "completed",
  "dismissed",
  "superseded",
] as const;

export type LifeOpsCommitmentStatus =
  (typeof LIFEOPS_COMMITMENT_STATUSES)[number];

export interface LifeOpsCommitmentLedgerRecord {
  id: string;
  agentId: string;
  source: LifeOpsCommitmentSource;
  sourceKey: string;
  kind: LifeOpsCommitmentKind;
  summary: string;
  counterparty: string | null;
  dueAt: string | null;
  confidence: number;
  status: LifeOpsCommitmentStatus;
  scheduledTaskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommitmentExtractionInput {
  agentId: string;
  source: LifeOpsCommitmentSource;
  sourceKey: string;
  text: string;
  observedAt: string;
  counterparty?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DocumentObligationInput {
  agentId: string;
  documentId: string;
  title: string;
  deadline: string;
  observedAt: string;
  note?: string | null;
  counterparty?: string | null;
  scheduledTaskId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CommitmentRegretAuditItem {
  record: ActiveLifeOpsCommitmentLedgerRecord;
  score: number;
  reasons: string[];
}

export type ActiveLifeOpsCommitmentLedgerRecord =
  LifeOpsCommitmentLedgerRecord & {
    status: "open" | "tracked";
  };

export interface CommitmentRegretAudit {
  generatedAt: string;
  horizonEndAt: string;
  items: CommitmentRegretAuditItem[];
}

const COMMITMENT_RE =
  /\b(i(?:'ll| will| can| need to| owe| promised to)|we(?:'ll| will| need to)|let me|i am going to)\b/i;
const SPECULATIVE_RE =
  /\b(maybe|sometime|eventually|if we get around to it|might|could)\b/i;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function invalidCommitmentLedgerRecord(
  value: Record<string, unknown>,
  field: string,
): never {
  throw new ElizaError(
    "[LifeOpsCommitmentLedger] Record violates the commitment ledger contract",
    {
      code: "LIFEOPS_COMMITMENT_LEDGER_INVALID_RECORD",
      context: {
        field,
        recordId:
          typeof value.id === "string" && value.id.length > 0 ? value.id : null,
        agentId:
          typeof value.agentId === "string" && value.agentId.length > 0
            ? value.agentId
            : null,
      },
    },
  );
}

function requiredLedgerText(
  value: Record<string, unknown>,
  field: string,
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    return invalidCommitmentLedgerRecord(value, field);
  }
  return fieldValue;
}

function nullableLedgerText(
  value: Record<string, unknown>,
  field: string,
): string | null {
  const fieldValue = value[field];
  if (fieldValue === null) return null;
  if (typeof fieldValue !== "string") {
    return invalidCommitmentLedgerRecord(value, field);
  }
  return fieldValue;
}

function ledgerEnum<const Values extends readonly string[]>(
  value: Record<string, unknown>,
  field: string,
  allowed: Values,
): Values[number] {
  const fieldValue = requiredLedgerText(value, field);
  if (!allowed.includes(fieldValue as Values[number])) {
    return invalidCommitmentLedgerRecord(value, field);
  }
  return fieldValue as Values[number];
}

function canonicalLedgerInstant(
  value: Record<string, unknown>,
  field: string,
): string {
  const fieldValue = requiredLedgerText(value, field);
  const timestamp = Date.parse(fieldValue);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== fieldValue
  ) {
    return invalidCommitmentLedgerRecord(value, field);
  }
  return fieldValue;
}

function nullableLedgerInstant(
  value: Record<string, unknown>,
  field: string,
): string | null {
  if (value[field] === null) return null;
  return canonicalLedgerInstant(value, field);
}

function ledgerConfidence(value: Record<string, unknown>): number {
  const raw = value.confidence;
  const confidence =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return invalidCommitmentLedgerRecord(value, "confidence");
  }
  return confidence;
}

/**
 * Validate a commitment row at a persistence boundary. SQL adapters may return
 * numeric columns as strings, but every other scalar must already match the
 * canonical domain representation; malformed stored values fail typed rather
 * than leaking through a public projection or being silently normalized.
 */
export function parseLifeOpsCommitmentLedgerRecord(
  input: unknown,
): LifeOpsCommitmentLedgerRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalidCommitmentLedgerRecord({}, "record");
  }
  const value = input as Record<string, unknown>;
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return invalidCommitmentLedgerRecord(value, "metadata");
  }
  return {
    id: requiredLedgerText(value, "id"),
    agentId: requiredLedgerText(value, "agentId"),
    source: ledgerEnum(value, "source", LIFEOPS_COMMITMENT_SOURCES),
    sourceKey: requiredLedgerText(value, "sourceKey"),
    kind: ledgerEnum(value, "kind", LIFEOPS_COMMITMENT_KINDS),
    summary: requiredLedgerText(value, "summary"),
    counterparty: nullableLedgerText(value, "counterparty"),
    dueAt: nullableLedgerInstant(value, "dueAt"),
    confidence: ledgerConfidence(value),
    status: ledgerEnum(value, "status", LIFEOPS_COMMITMENT_STATUSES),
    scheduledTaskId: nullableLedgerText(value, "scheduledTaskId"),
    metadata: metadata as Record<string, unknown>,
    createdAt: canonicalLedgerInstant(value, "createdAt"),
    updatedAt: canonicalLedgerInstant(value, "updatedAt"),
  };
}

function sha16(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function endOfUtcDay(date: Date): string {
  const next = new Date(date.getTime());
  next.setUTCHours(17, 0, 0, 0);
  return next.toISOString();
}

function nextWeekdayIso(observedAt: string, weekdayName: string): string {
  const base = new Date(observedAt);
  const target = WEEKDAYS.indexOf(
    weekdayName.toLowerCase() as (typeof WEEKDAYS)[number],
  );
  if (target < 0 || Number.isNaN(base.getTime())) return observedAt;
  const today = base.getUTCDay();
  let delta = (target - today + 7) % 7;
  if (delta === 0) delta = 7;
  return endOfUtcDay(addUtcDays(base, delta));
}

function resolveDueAt(text: string, observedAt: string): string | null {
  const isoDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoDate?.[1]) {
    return endOfUtcDay(new Date(`${isoDate[1]}T00:00:00.000Z`));
  }
  if (/\btomorrow\b/i.test(text)) {
    return endOfUtcDay(addUtcDays(new Date(observedAt), 1));
  }
  const weekdayPattern = new RegExp(
    `\\b(?:by|before|on|next)?\\s*(${WEEKDAYS.join("|")})\\b`,
    "i",
  );
  const weekday = text.match(weekdayPattern)?.[1];
  return weekday ? nextWeekdayIso(observedAt, weekday) : null;
}

function classifyKind(text: string): LifeOpsCommitmentKind {
  if (/\b(renew|renewal|cancellation deadline|trial ends)\b/i.test(text)) {
    return "renewal";
  }
  if (/\b(file|filing|submit|tax|court|deadline)\b/i.test(text)) {
    return "filing";
  }
  if (/\b(warranty|guarantee|return window)\b/i.test(text)) {
    return "warranty";
  }
  return "commitment";
}

function classifyDocumentObligationKind(text: string): LifeOpsCommitmentKind {
  if (/\b(renew|renewal|auto-renew|term|msa|sow|contract)\b/i.test(text)) {
    return "renewal";
  }
  if (/\b(warranty|guarantee|return window|rma)\b/i.test(text)) {
    return "warranty";
  }
  if (
    /\b(file|filing|submit|tax|court|compliance|license|permit)\b/i.test(text)
  ) {
    return "filing";
  }
  return "commitment";
}

function firstCommitmentSentence(text: string): string | null {
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    const sentence = normalizeText(part);
    if (!sentence) continue;
    if (!COMMITMENT_RE.test(sentence)) continue;
    if (SPECULATIVE_RE.test(sentence)) continue;
    return sentence.replace(/[.!?]+$/, "");
  }
  return null;
}

export function createLifeOpsCommitmentLedgerRecord(
  params: Omit<
    LifeOpsCommitmentLedgerRecord,
    "id" | "createdAt" | "updatedAt" | "status" | "scheduledTaskId"
  > & {
    id?: string;
    status?: LifeOpsCommitmentStatus;
    scheduledTaskId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  },
): LifeOpsCommitmentLedgerRecord {
  const timestamp = params.createdAt ?? new Date().toISOString();
  const summary = normalizeText(params.summary);
  return {
    ...params,
    id:
      params.id ??
      `commit_${sha16(`${params.agentId}:${params.source}:${params.sourceKey}:${params.kind}:${summary}`)}`,
    summary,
    confidence: clampConfidence(params.confidence),
    status: params.status ?? "open",
    scheduledTaskId: params.scheduledTaskId ?? null,
    createdAt: timestamp,
    updatedAt: params.updatedAt ?? timestamp,
  };
}

export function extractCommitmentLedgerRecords(
  input: CommitmentExtractionInput,
): LifeOpsCommitmentLedgerRecord[] {
  const sentence = firstCommitmentSentence(input.text);
  if (!sentence) return [];
  const kind = classifyKind(sentence);
  return [
    createLifeOpsCommitmentLedgerRecord({
      agentId: input.agentId,
      source: input.source,
      sourceKey: input.sourceKey,
      kind,
      summary: sentence,
      counterparty: input.counterparty?.trim() || null,
      dueAt: resolveDueAt(sentence, input.observedAt),
      confidence: kind === "commitment" ? 0.74 : 0.82,
      metadata: {
        ...(input.metadata ?? {}),
        observedAt: input.observedAt,
        textSha256: crypto
          .createHash("sha256")
          .update(input.text)
          .digest("hex"),
      },
    }),
  ];
}

export function createDocumentObligationLedgerRecord(
  input: DocumentObligationInput,
): LifeOpsCommitmentLedgerRecord {
  const text = normalizeText(`${input.title} ${input.note ?? ""}`);
  const kind = classifyDocumentObligationKind(text);
  return createLifeOpsCommitmentLedgerRecord({
    agentId: input.agentId,
    source: "document",
    sourceKey: input.documentId,
    kind,
    summary: `${input.title} deadline`,
    counterparty: input.counterparty?.trim() || null,
    dueAt: input.deadline,
    confidence: kind === "commitment" ? 0.76 : 0.9,
    status: input.scheduledTaskId ? "tracked" : "open",
    scheduledTaskId: input.scheduledTaskId ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      observedAt: input.observedAt,
      documentTitle: input.title,
      ...(input.note ? { noteSha256: sha16(input.note) } : {}),
    },
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });
}

export function buildCommitmentRegretAudit(
  records: LifeOpsCommitmentLedgerRecord[],
  args: { nowIso: string; horizonDays?: number } = {
    nowIso: new Date().toISOString(),
  },
): CommitmentRegretAudit {
  const now = new Date(args.nowIso);
  const horizonEnd = addUtcDays(now, args.horizonDays ?? 7);
  const horizonEndAt = horizonEnd.toISOString();
  const items = records
    .filter(
      (record): record is ActiveLifeOpsCommitmentLedgerRecord =>
        record.status === "open" || record.status === "tracked",
    )
    .map((record): CommitmentRegretAuditItem => {
      const reasons: string[] = [];
      let score = record.confidence;
      if (!record.scheduledTaskId) {
        score += 0.35;
        reasons.push("no scheduled tracker");
      }
      if (record.dueAt) {
        const due = new Date(record.dueAt);
        if (due <= horizonEnd) {
          score += 0.3;
          reasons.push("due inside audit horizon");
        }
        if (due < now) {
          score += 0.25;
          reasons.push("overdue");
        }
      } else {
        score += 0.12;
        reasons.push("no explicit due date");
      }
      if (record.kind !== "commitment") {
        score += 0.15;
        reasons.push(`${record.kind} obligation`);
      }
      return { record, score: Number(score.toFixed(3)), reasons };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.record.createdAt.localeCompare(b.record.createdAt) ||
        a.record.id.localeCompare(b.record.id),
    );
  return { generatedAt: args.nowIso, horizonEndAt, items };
}
