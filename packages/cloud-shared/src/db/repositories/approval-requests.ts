import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { dbWrite as db } from "../client";
import {
  type ApprovalChallengeKind,
  type ApprovalChallengePayload,
  type ApprovalRequestRow as ApprovalRequestDbRow,
  type ApprovalRequestEventRow as ApprovalRequestEventDbRow,
  type ApprovalRequestStatus,
  approvalRequestEvents,
  approvalRequests,
  type NewApprovalRequest as NewApprovalRequestDbRow,
  type NewApprovalRequestEvent as NewApprovalRequestEventDbRow,
} from "../schemas/approval-requests";

export interface ListApprovalRequestsFilter {
  organizationId: string;
  status?: ApprovalRequestStatus;
  agentId?: string;
  challengeKind?: ApprovalChallengeKind;
  expectedSignerIdentityId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface ApprovalRequestRow {
  id: string;
  organizationId: string;
  agentId: string | null;
  userId: string | null;
  challengeKind: ApprovalChallengeKind;
  challengePayload: ApprovalChallengePayload;
  expectedSignerIdentityId: string | null;
  status: ApprovalRequestStatus;
  signatureText: string | null;
  signedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface NewApprovalRequest {
  organizationId: string;
  agentId?: string | null;
  userId?: string | null;
  challengeKind: ApprovalChallengeKind;
  challengePayload: ApprovalChallengePayload;
  expectedSignerIdentityId?: string | null;
  status?: ApprovalRequestStatus;
  signatureText?: string | null;
  signedAt?: Date | null;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface NewApprovalRequestEvent {
  approvalRequestId: string;
  eventName: NewApprovalRequestEventDbRow["event_name"];
  redactedPayload?: Record<string, unknown>;
}

export type ApprovalRequestEventRow = ApprovalRequestEventDbRow;

function toDbInsert(input: NewApprovalRequest): NewApprovalRequestDbRow {
  return {
    organization_id: input.organizationId,
    agent_id: input.agentId ?? null,
    user_id: input.userId ?? null,
    challenge_kind: input.challengeKind,
    challenge_payload: input.challengePayload,
    expected_signer_identity_id: input.expectedSignerIdentityId ?? null,
    status: input.status ?? "pending",
    signature_text: input.signatureText ?? null,
    signed_at: input.signedAt ?? null,
    expires_at: input.expiresAt,
    metadata: input.metadata ?? {},
  };
}

function toDbPatch(input: Partial<NewApprovalRequest>): Partial<NewApprovalRequestDbRow> {
  const patch: Partial<NewApprovalRequestDbRow> = {};
  if (input.organizationId !== undefined) patch.organization_id = input.organizationId;
  if (input.agentId !== undefined) patch.agent_id = input.agentId;
  if (input.userId !== undefined) patch.user_id = input.userId;
  if (input.challengeKind !== undefined) patch.challenge_kind = input.challengeKind;
  if (input.challengePayload !== undefined) patch.challenge_payload = input.challengePayload;
  if (input.expectedSignerIdentityId !== undefined) {
    patch.expected_signer_identity_id = input.expectedSignerIdentityId;
  }
  if (input.status !== undefined) patch.status = input.status;
  if (input.signatureText !== undefined) patch.signature_text = input.signatureText;
  if (input.signedAt !== undefined) patch.signed_at = input.signedAt;
  if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  return patch;
}

function toDomain(row: ApprovalRequestDbRow): ApprovalRequestRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    userId: row.user_id,
    challengeKind: row.challenge_kind,
    challengePayload: row.challenge_payload,
    expectedSignerIdentityId: row.expected_signer_identity_id,
    status: row.status,
    signatureText: row.signature_text,
    signedAt: row.signed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata,
  };
}

function toDbEvent(input: NewApprovalRequestEvent): NewApprovalRequestEventDbRow {
  return {
    approval_request_id: input.approvalRequestId,
    event_name: input.eventName,
    redacted_payload: input.redactedPayload ?? {},
  };
}

export class ApprovalRequestsRepository {
  async createApprovalRequest(input: NewApprovalRequest): Promise<ApprovalRequestRow> {
    const [row] = await db.insert(approvalRequests).values(toDbInsert(input)).returning();
    return toDomain(row);
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequestRow | null> {
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async listApprovalRequests(filter: ListApprovalRequestsFilter): Promise<ApprovalRequestRow[]> {
    const conditions = [eq(approvalRequests.organization_id, filter.organizationId)];
    if (filter.status) conditions.push(eq(approvalRequests.status, filter.status));
    if (filter.agentId) conditions.push(eq(approvalRequests.agent_id, filter.agentId));
    if (filter.challengeKind) {
      conditions.push(eq(approvalRequests.challenge_kind, filter.challengeKind));
    }
    if (filter.expectedSignerIdentityId) {
      conditions.push(
        eq(approvalRequests.expected_signer_identity_id, filter.expectedSignerIdentityId),
      );
    }
    if (filter.since) conditions.push(gte(approvalRequests.created_at, filter.since));
    if (filter.until) conditions.push(lte(approvalRequests.created_at, filter.until));

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = await db
      .select()
      .from(approvalRequests)
      .where(and(...conditions))
      .orderBy(desc(approvalRequests.created_at))
      .limit(limit)
      .offset(offset);
    return rows.map(toDomain);
  }

  async setApprovalRequestStatus(
    id: string,
    status: ApprovalRequestStatus | null,
    patch: Partial<NewApprovalRequest> = {},
  ): Promise<ApprovalRequestRow | null> {
    const dbPatch = toDbPatch(patch);
    const [row] = await db
      .update(approvalRequests)
      .set({ ...dbPatch, ...(status ? { status } : {}), updated_at: new Date() })
      .where(eq(approvalRequests.id, id))
      .returning();
    return row ? toDomain(row) : null;
  }

  async recordApprovalRequestEvent(
    input: NewApprovalRequestEvent,
  ): Promise<ApprovalRequestEventRow> {
    const [row] = await db.insert(approvalRequestEvents).values(toDbEvent(input)).returning();
    return row;
  }

  async expirePastApprovalRequests(now: Date): Promise<string[]> {
    const expirable: ApprovalRequestStatus[] = ["pending", "delivered"];
    const rows = await db
      .update(approvalRequests)
      .set({ status: "expired", updated_at: now })
      .where(and(inArray(approvalRequests.status, expirable), lt(approvalRequests.expires_at, now)))
      .returning({ id: approvalRequests.id });
    return rows.map((r) => r.id);
  }
}

export const approvalRequestsRepository = new ApprovalRequestsRepository();

export type { ApprovalChallengeKind, ApprovalChallengePayload, ApprovalRequestStatus };
