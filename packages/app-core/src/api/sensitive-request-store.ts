import crypto from "node:crypto";
import {
  type JsonObject,
  redactSensitiveRequestMetadata,
  type SensitiveRequest,
  type SensitiveRequestEvent,
} from "@elizaos/core";

export const DEFAULT_SENSITIVE_REQUEST_TTL_MS = 15 * 60 * 1000;
export const MAX_SENSITIVE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface LocalSensitiveRequestRecord extends SensitiveRequest {
  tokenHash: string;
  tokenUsedAt?: string;
  audit?: SensitiveRequestAuditEvent[];
}

export interface SensitiveRequestAuditEvent {
  action: string;
  outcome: string;
  createdAt: string;
  metadata?: JsonObject;
}

export interface CreateLocalSensitiveRequestInput
  extends Omit<
    SensitiveRequest,
    "id" | "status" | "createdAt" | "updatedAt" | "expiresAt"
  > {
  ttlMs?: number;
  now?: number;
}

export type LocalSensitiveRequestSubmitTokenCheck =
  | { ok: true; record: LocalSensitiveRequestRecord }
  | {
      ok: false;
      status: 401 | 404 | 409 | 410;
      reason:
        | "not_found"
        | "expired"
        | "invalid_token"
        | "replayed"
        | "not_pending";
    };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeTokenHashEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function clampTtlMs(ttlMs: unknown): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_SENSITIVE_REQUEST_TTL_MS;
  }
  return Math.min(Math.max(1, Math.floor(ttlMs)), MAX_SENSITIVE_REQUEST_TTL_MS);
}

function redactedMetadata(
  metadata: JsonObject | undefined,
): JsonObject | undefined {
  if (!metadata) return undefined;
  return redactSensitiveRequestMetadata(metadata) as JsonObject;
}

export function createSensitiveRequestSubmitToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function redactLocalSensitiveRequest(
  record: LocalSensitiveRequestRecord,
): SensitiveRequest & { audit?: SensitiveRequestAuditEvent[] } {
  const {
    tokenHash: _tokenHash,
    tokenUsedAt: _tokenUsedAt,
    ...publicRecord
  } = record;
  return {
    ...publicRecord,
    callback: publicRecord.callback
      ? (redactSensitiveRequestMetadata(
          publicRecord.callback as never,
        ) as never)
      : undefined,
    audit: publicRecord.audit?.map((event) => ({
      ...event,
      metadata: redactedMetadata(event.metadata),
    })),
  };
}

export class LocalSensitiveRequestStore {
  private readonly records = new Map<string, LocalSensitiveRequestRecord>();

  create(input: CreateLocalSensitiveRequestInput): {
    record: LocalSensitiveRequestRecord;
    submitToken: string;
  } {
    const now = input.now ?? Date.now();
    const ttlMs = clampTtlMs(input.ttlMs);
    const submitToken = createSensitiveRequestSubmitToken();
    const createdAt = iso(now);
    const record: LocalSensitiveRequestRecord = {
      id: crypto.randomUUID(),
      kind: input.kind,
      status: "pending",
      agentId: input.agentId,
      organizationId: input.organizationId,
      ownerEntityId: input.ownerEntityId,
      requesterEntityId: input.requesterEntityId,
      sourceRoomId: input.sourceRoomId,
      sourceChannelType: input.sourceChannelType,
      sourcePlatform: input.sourcePlatform,
      target: input.target,
      policy: input.policy,
      delivery: input.delivery,
      callback: input.callback,
      expiresAt: iso(now + ttlMs),
      createdAt,
      updatedAt: createdAt,
      tokenHash: tokenHash(submitToken),
      audit: [
        {
          action: "created",
          outcome: "success",
          createdAt,
          metadata: redactedMetadata({
            kind: input.kind,
            deliveryMode: input.delivery.mode,
            source: input.delivery.source,
          }) as never,
        },
      ],
    };
    this.records.set(record.id, record);
    return { record, submitToken };
  }

  get(id: string, now = Date.now()): LocalSensitiveRequestRecord | null {
    const record = this.records.get(id) ?? null;
    if (!record) return null;
    this.expireIfNeeded(record, now);
    return record;
  }

  checkSubmitToken(
    id: string,
    token: string,
    now = Date.now(),
  ): LocalSensitiveRequestSubmitTokenCheck {
    const record = this.records.get(id);
    if (!record) return { ok: false, status: 404, reason: "not_found" };
    this.expireIfNeeded(record, now);
    if (record.status === "expired") {
      return { ok: false, status: 410, reason: "expired" };
    }
    if (record.tokenUsedAt) {
      return { ok: false, status: 409, reason: "replayed" };
    }
    if (record.status !== "pending") {
      return { ok: false, status: 409, reason: "not_pending" };
    }
    const providedHash = tokenHash(token);
    if (!timingSafeTokenHashEqual(record.tokenHash, providedHash)) {
      this.appendAudit(record, {
        action: "submitted",
        outcome: "failure",
        createdAt: iso(now),
        metadata: { reason: "invalid_token" },
      });
      return { ok: false, status: 401, reason: "invalid_token" };
    }
    return { ok: true, record };
  }

  consumeSubmitToken(
    id: string,
    token: string,
    now = Date.now(),
  ): LocalSensitiveRequestSubmitTokenCheck {
    const check = this.checkSubmitToken(id, token, now);
    if (check.ok === false) return check;
    check.record.tokenUsedAt = iso(now);
    this.appendAudit(check.record, {
      action: "submitted",
      outcome: "success",
      createdAt: iso(now),
      metadata: { kind: check.record.kind },
    });
    return check;
  }

  fulfill(id: string, event: SensitiveRequestEvent, now = Date.now()): void {
    const record = this.records.get(id);
    if (!record) return;
    const at = iso(now);
    record.status = "fulfilled";
    record.fulfilledAt = at;
    record.updatedAt = at;
    this.appendAudit(record, {
      action: "fulfilled",
      outcome: "success",
      createdAt: at,
      metadata: redactedMetadata({ event } as unknown as JsonObject),
    });
  }

  fail(id: string, reason: string, now = Date.now()): void {
    const record = this.records.get(id);
    if (!record) return;
    const at = iso(now);
    record.status = "failed";
    record.updatedAt = at;
    this.appendAudit(record, {
      action: "failed",
      outcome: "failure",
      createdAt: at,
      metadata: { reason },
    });
  }

  cancel(id: string, now = Date.now()): LocalSensitiveRequestRecord | null {
    const record = this.records.get(id) ?? null;
    if (!record) return null;
    this.expireIfNeeded(record, now);
    if (record.status !== "pending") return record;
    const at = iso(now);
    record.status = "canceled";
    record.updatedAt = at;
    this.appendAudit(record, {
      action: "canceled",
      outcome: "success",
      createdAt: at,
    });
    return record;
  }

  appendAudit(
    record: LocalSensitiveRequestRecord,
    event: SensitiveRequestAuditEvent,
  ): void {
    const audit = record.audit ?? [];
    audit.push({
      ...event,
      metadata: redactedMetadata(event.metadata),
    });
    record.audit = audit.slice(-100);
    record.updatedAt = event.createdAt;
  }

  reset(): void {
    this.records.clear();
  }

  private expireIfNeeded(
    record: LocalSensitiveRequestRecord,
    now = Date.now(),
  ): void {
    if (record.status !== "pending") return;
    if (Date.parse(record.expiresAt) > now) return;
    const at = iso(now);
    record.status = "expired";
    record.updatedAt = at;
    this.appendAudit(record, {
      action: "expired",
      outcome: "success",
      createdAt: at,
    });
  }
}

export const localSensitiveRequestStore = new LocalSensitiveRequestStore();
