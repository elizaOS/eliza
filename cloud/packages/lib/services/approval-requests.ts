import type {
  ApprovalRequestRow,
  ApprovalRequestsRepository,
} from "@/db/repositories/approval-requests";
import { logger } from "@/lib/utils/logger";

export type { ApprovalRequestRow } from "@/db/repositories/approval-requests";

export type ApprovalChallengeKind = ApprovalRequestRow["challengeKind"];
export type ApprovalRequestStatus = ApprovalRequestRow["status"];

const DEFAULT_EXPIRES_IN_MS = 15 * 60 * 1000; // 15 minutes
const TERMINAL_STATUSES: ReadonlySet<ApprovalRequestStatus> = new Set([
  "approved",
  "denied",
  "expired",
  "canceled",
]);

const SUPPORTED_CHALLENGE_KINDS: ReadonlyArray<ApprovalChallengeKind> = [
  "login",
  "signature",
  "generic",
];

export interface CreateApprovalRequestInput {
  organizationId: string;
  agentId?: string | null;
  userId?: string | null;
  challengeKind: ApprovalChallengeKind;
  challengePayload?: Record<string, unknown>;
  expectedSignerIdentityId?: string | null;
  callbackUrl?: string;
  callbackSecret?: string;
  hostedUrl?: string;
  expiresInMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ListApprovalRequestsFilter {
  status?: ApprovalRequestStatus;
  agentId?: string;
  challengeKind?: ApprovalChallengeKind;
  limit?: number;
  offset?: number;
}

export interface ApprovalRequestsService {
  create(input: CreateApprovalRequestInput): Promise<ApprovalRequestRow>;
  get(id: string, organizationId: string): Promise<ApprovalRequestRow | null>;
  getPublic(id: string): Promise<ApprovalRequestRow | null>;
  list(organizationId: string, filter?: ListApprovalRequestsFilter): Promise<ApprovalRequestRow[]>;
  markDelivered(id: string, hostedUrl?: string | null): Promise<ApprovalRequestRow>;
  markApproved(
    id: string,
    args: { signatureText?: string; signerIdentityId?: string },
  ): Promise<ApprovalRequestRow>;
  markDenied(id: string, reason?: string): Promise<ApprovalRequestRow>;
  cancel(id: string, organizationId: string, reason?: string): Promise<ApprovalRequestRow>;
  expirePast(now?: Date): Promise<string[]>;
}

interface ApprovalRequestsServiceDeps {
  repository: ApprovalRequestsRepository;
}

function validateCreateInput(input: CreateApprovalRequestInput): void {
  if (!input.organizationId) {
    throw new Error("organizationId is required");
  }
  if (!SUPPORTED_CHALLENGE_KINDS.includes(input.challengeKind)) {
    throw new Error(`Unsupported challenge kind: ${input.challengeKind}`);
  }
  if (input.callbackSecret && !input.callbackUrl) {
    throw new Error("callbackSecret requires callbackUrl");
  }
  if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
    throw new Error("expiresInMs must be positive");
  }
}

function redactPayload(args: {
  approvalRequest: ApprovalRequestRow;
  status: ApprovalRequestStatus;
  reason?: string;
  signerIdentityId?: string;
}): Record<string, unknown> {
  return {
    approvalRequestId: args.approvalRequest.id,
    organizationId: args.approvalRequest.organizationId,
    challengeKind: args.approvalRequest.challengeKind,
    status: args.status,
    expectedSignerIdentityId: args.approvalRequest.expectedSignerIdentityId,
    signerIdentityId: args.signerIdentityId,
    reason: args.reason,
  };
}

function assertNotTerminal(row: ApprovalRequestRow, action: string): void {
  if (TERMINAL_STATUSES.has(row.status)) {
    throw new Error(
      `Cannot ${action} approval request ${row.id}: already in terminal status "${row.status}"`,
    );
  }
}

function assertCancelable(row: ApprovalRequestRow): void {
  if (row.status !== "pending" && row.status !== "delivered") {
    throw new Error(
      `Cannot cancel approval request ${row.id}: status "${row.status}" is not cancelable`,
    );
  }
}

function requireRow(
  row: ApprovalRequestRow | null | undefined,
  id: string,
  context: string,
): ApprovalRequestRow {
  if (!row) {
    throw new Error(`Approval request ${id} not found (${context})`);
  }
  return row;
}

class ApprovalRequestsServiceImpl implements ApprovalRequestsService {
  private readonly repository: ApprovalRequestsRepository;

  constructor(deps: ApprovalRequestsServiceDeps) {
    this.repository = deps.repository;
  }

  async create(input: CreateApprovalRequestInput): Promise<ApprovalRequestRow> {
    validateCreateInput(input);

    const expiresInMs = input.expiresInMs ?? DEFAULT_EXPIRES_IN_MS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInMs);

    const created = await this.repository.createApprovalRequest({
      organizationId: input.organizationId,
      agentId: input.agentId ?? null,
      userId: input.userId ?? null,
      challengeKind: input.challengeKind,
      challengePayload: input.challengePayload ?? {},
      expectedSignerIdentityId: input.expectedSignerIdentityId ?? null,
      hostedUrl: input.hostedUrl ?? null,
      callbackUrl: input.callbackUrl ?? null,
      callbackSecret: input.callbackSecret ?? null,
      expiresAt,
      metadata: input.metadata ?? {},
    });

    await this.repository.recordEvent({
      approvalRequestId: created.id,
      eventName: "approval.created",
      redactedPayload: redactPayload({
        approvalRequest: created,
        status: created.status,
      }),
    });

    logger.info("[ApprovalRequests] Created approval request", {
      approvalRequestId: created.id,
      organizationId: created.organizationId,
      challengeKind: created.challengeKind,
      expectedSignerIdentityId: created.expectedSignerIdentityId,
    });

    return created;
  }

  async get(id: string, organizationId: string): Promise<ApprovalRequestRow | null> {
    const row = await this.repository.getApprovalRequest(id);
    if (!row || row.organizationId !== organizationId) return null;
    return row;
  }

  async getPublic(id: string): Promise<ApprovalRequestRow | null> {
    return this.repository.getApprovalRequest(id);
  }

  async list(
    organizationId: string,
    filter: ListApprovalRequestsFilter = {},
  ): Promise<ApprovalRequestRow[]> {
    return this.repository.listApprovalRequests({
      organizationId,
      status: filter.status,
      agentId: filter.agentId,
      challengeKind: filter.challengeKind,
      limit: filter.limit,
      offset: filter.offset,
    });
  }

  async markDelivered(id: string, hostedUrl?: string | null): Promise<ApprovalRequestRow> {
    const updated = requireRow(
      await this.repository.setStatus(id, "delivered", { hostedUrl: hostedUrl ?? undefined }),
      id,
      "markDelivered update",
    );

    await this.repository.recordEvent({
      approvalRequestId: id,
      eventName: "approval.delivered",
      redactedPayload: redactPayload({
        approvalRequest: updated,
        status: updated.status,
      }),
    });

    return updated;
  }

  async markApproved(
    id: string,
    args: { signatureText?: string; signerIdentityId?: string },
  ): Promise<ApprovalRequestRow> {
    const existing = requireRow(
      await this.repository.getApprovalRequest(id),
      id,
      "markApproved lookup",
    );
    if (existing.status === "approved") {
      return existing;
    }
    assertNotTerminal(existing, "approve");

    const signedAt = new Date();
    const updated = requireRow(
      await this.repository.setStatus(id, "approved", {
        signatureText: args.signatureText ?? null,
        signedAt,
      }),
      id,
      "markApproved update",
    );

    await this.repository.recordEvent({
      approvalRequestId: id,
      eventName: "approval.approved",
      redactedPayload: redactPayload({
        approvalRequest: updated,
        status: "approved",
        signerIdentityId: args.signerIdentityId,
      }),
    });

    logger.info("[ApprovalRequests] Approved approval request", {
      approvalRequestId: id,
      challengeKind: updated.challengeKind,
      signerIdentityId: args.signerIdentityId,
    });

    return updated;
  }

  async markDenied(id: string, reason?: string): Promise<ApprovalRequestRow> {
    const existing = requireRow(
      await this.repository.getApprovalRequest(id),
      id,
      "markDenied lookup",
    );
    if (existing.status === "denied") {
      return existing;
    }
    assertNotTerminal(existing, "deny");

    const updated = requireRow(
      await this.repository.setStatus(id, "denied"),
      id,
      "markDenied update",
    );

    await this.repository.recordEvent({
      approvalRequestId: id,
      eventName: "approval.denied",
      redactedPayload: redactPayload({
        approvalRequest: updated,
        status: "denied",
        reason,
      }),
    });

    logger.info("[ApprovalRequests] Denied approval request", {
      approvalRequestId: id,
      reason,
    });

    return updated;
  }

  async cancel(id: string, organizationId: string, reason?: string): Promise<ApprovalRequestRow> {
    const existing = requireRow(await this.repository.getApprovalRequest(id), id, "cancel lookup");
    if (existing.organizationId !== organizationId) {
      throw new Error(`Approval request ${id} does not belong to organization ${organizationId}`);
    }
    assertCancelable(existing);

    const updated = requireRow(
      await this.repository.setStatus(id, "canceled"),
      id,
      "cancel update",
    );

    await this.repository.recordEvent({
      approvalRequestId: id,
      eventName: "approval.canceled",
      redactedPayload: redactPayload({
        approvalRequest: updated,
        status: "canceled",
        reason,
      }),
    });

    logger.info("[ApprovalRequests] Canceled approval request", {
      approvalRequestId: id,
      organizationId,
      reason,
    });

    return updated;
  }

  async expirePast(now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePast(now);
    for (const id of expiredIds) {
      const row = await this.repository.getApprovalRequest(id);
      if (!row) continue;
      await this.repository.recordEvent({
        approvalRequestId: id,
        eventName: "approval.expired",
        redactedPayload: redactPayload({
          approvalRequest: row,
          status: "expired",
        }),
      });
    }
    if (expiredIds.length > 0) {
      logger.info("[ApprovalRequests] Expired approval requests", {
        count: expiredIds.length,
      });
    }
    return expiredIds;
  }
}

export function createApprovalRequestsService(
  deps: ApprovalRequestsServiceDeps,
): ApprovalRequestsService {
  return new ApprovalRequestsServiceImpl(deps);
}

export function redactApprovalRequestForPublic(
  row: ApprovalRequestRow,
): Omit<ApprovalRequestRow, "callbackSecret" | "signatureText"> {
  const { callbackSecret: _callbackSecret, signatureText: _signatureText, ...publicRow } = row;
  return publicRow;
}
