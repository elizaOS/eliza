import { ElizaError } from "@elizaos/core";
// Coordinates cloud service approval requests behavior behind route handlers.
import type {
  ApprovalChallengeKind,
  ApprovalChallengePayload,
  ApprovalRequestRow,
  ApprovalRequestStatus,
  ApprovalRequestsRepository,
} from "../../db/repositories/approval-requests";
import { logger } from "../utils/logger";

export type { ApprovalRequestRow } from "../../db/repositories/approval-requests";
export type { ApprovalChallengeKind, ApprovalChallengePayload, ApprovalRequestStatus };

const DEFAULT_EXPIRES_IN_MS = 10 * 60 * 1000; // 10 minutes
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
  challengePayload: ApprovalChallengePayload;
  expectedSignerIdentityId?: string | null;
  expiresInMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ListApprovalRequestsFilter {
  status?: ApprovalRequestStatus;
  agentId?: string;
  challengeKind?: ApprovalChallengeKind;
  expectedSignerIdentityId?: string;
  limit?: number;
  offset?: number;
}

export interface MarkApprovedInput {
  approvalRequestId: string;
  signatureText: string;
  signerIdentityId: string;
}

export interface ApprovalRequestsService {
  create(input: CreateApprovalRequestInput): Promise<ApprovalRequestRow>;
  get(id: string, organizationId: string): Promise<ApprovalRequestRow | null>;
  getPublic(id: string): Promise<ApprovalRequestRow | null>;
  list(organizationId: string, filter?: ListApprovalRequestsFilter): Promise<ApprovalRequestRow[]>;
  markDelivered(id: string): Promise<ApprovalRequestRow>;
  markApproved(input: MarkApprovedInput): Promise<ApprovalRequestRow>;
  markDenied(id: string, reason?: string): Promise<ApprovalRequestRow>;
  cancel(id: string, organizationId: string, reason?: string): Promise<ApprovalRequestRow>;
  expirePast(now?: Date): Promise<string[]>;
}

interface ApprovalRequestsServiceDeps {
  repository: ApprovalRequestsRepository;
}

function validateCreateInput(input: CreateApprovalRequestInput): void {
  if (!input.organizationId) {
    throw new ElizaError("organizationId is required", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (!SUPPORTED_CHALLENGE_KINDS.includes(input.challengeKind)) {
    throw new ElizaError(`Unsupported challengeKind: ${input.challengeKind}`, {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (!input.challengePayload || typeof input.challengePayload !== "object") {
    throw new ElizaError("challengePayload is required", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  const message = input.challengePayload.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new ElizaError("challengePayload.message is required", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  const signerKind = input.challengePayload.signerKind;
  if (signerKind && signerKind !== "wallet" && signerKind !== "ed25519") {
    throw new ElizaError(`Unsupported challengePayload.signerKind: ${signerKind}`, {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (signerKind === "wallet" && !input.challengePayload.walletAddress) {
    throw new ElizaError("challengePayload.walletAddress is required for wallet signers", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (signerKind === "ed25519" && !input.challengePayload.publicKey) {
    throw new ElizaError("challengePayload.publicKey is required for ed25519 signers", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
  if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
    throw new ElizaError("expiresInMs must be positive", {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
  }
}

function assertNotTerminal(row: ApprovalRequestRow, action: string): void {
  if (TERMINAL_STATUSES.has(row.status)) {
    throw new ElizaError(
      `Cannot ${action} approval request ${row.id}: already in terminal status "${row.status}"`,
      { code: "AUTHORIZATION_INTENT_INVALID_STATE", severity: "ephemeral" },
    );
  }
}

function assertCancelable(row: ApprovalRequestRow): void {
  if (row.status !== "pending" && row.status !== "delivered") {
    throw new ElizaError(
      `Cannot cancel approval request ${row.id}: status "${row.status}" is not cancelable`,
      { code: "AUTHORIZATION_INTENT_INVALID_STATE", severity: "ephemeral" },
    );
  }
}

function requireRow(
  row: ApprovalRequestRow | null | undefined,
  id: string,
  context: string,
): ApprovalRequestRow {
  if (!row) {
    throw new ElizaError(`Approval request ${id} not found (${context})`, {
      code: "AUTHORIZATION_INTENT_INVALID_STATE",
      severity: "ephemeral",
    });
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
      challengePayload: input.challengePayload,
      expectedSignerIdentityId: input.expectedSignerIdentityId ?? null,
      expiresAt,
      metadata: input.metadata ?? {},
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
      expectedSignerIdentityId: filter.expectedSignerIdentityId,
      limit: filter.limit,
      offset: filter.offset,
    });
  }

  async markDelivered(id: string): Promise<ApprovalRequestRow> {
    const existing = requireRow(
      await this.repository.getApprovalRequest(id),
      id,
      "markDelivered lookup",
    );
    if (existing.status !== "pending") {
      return existing;
    }
    const updated = requireRow(
      await this.repository.transitionApprovalRequest(id, "delivered"),
      id,
      "markDelivered update",
    );
    return updated;
  }

  async markApproved(input: MarkApprovedInput): Promise<ApprovalRequestRow> {
    const existing = requireRow(
      await this.repository.getApprovalRequest(input.approvalRequestId),
      input.approvalRequestId,
      "markApproved lookup",
    );
    assertNotTerminal(existing, "approve");

    const signedAt = new Date();
    const updated = requireRow(
      await this.repository.transitionApprovalRequest(input.approvalRequestId, "approved", {
        patch: { signatureText: input.signatureText, signedAt },
        eventPayload: { signerIdentityId: input.signerIdentityId },
      }),
      input.approvalRequestId,
      "markApproved update",
    );

    logger.info("[ApprovalRequests] Approved approval request", {
      approvalRequestId: input.approvalRequestId,
      signerIdentityId: input.signerIdentityId,
    });

    return updated;
  }

  async markDenied(id: string, reason?: string): Promise<ApprovalRequestRow> {
    const existing = requireRow(
      await this.repository.getApprovalRequest(id),
      id,
      "markDenied lookup",
    );
    assertNotTerminal(existing, "deny");

    const updated = requireRow(
      await this.repository.transitionApprovalRequest(id, "denied", { eventPayload: { reason } }),
      id,
      "markDenied update",
    );

    logger.info("[ApprovalRequests] Denied approval request", {
      approvalRequestId: id,
      reason,
    });

    return updated;
  }

  async cancel(id: string, organizationId: string, reason?: string): Promise<ApprovalRequestRow> {
    const existing = requireRow(await this.repository.getApprovalRequest(id), id, "cancel lookup");
    if (existing.organizationId !== organizationId) {
      throw new ElizaError(
        `Approval request ${id} does not belong to organization ${organizationId}`,
        { code: "AUTHORIZATION_INTENT_INVALID_STATE", severity: "ephemeral" },
      );
    }
    assertCancelable(existing);

    const updated = requireRow(
      await this.repository.transitionApprovalRequest(id, "canceled", {
        organizationId,
        eventPayload: { reason },
      }),
      id,
      "cancel update",
    );

    logger.info("[ApprovalRequests] Canceled approval request", {
      approvalRequestId: id,
      organizationId,
      reason,
    });

    return updated;
  }

  async expirePast(now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePastApprovalRequests(now);
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
): Omit<ApprovalRequestRow, "signatureText"> {
  const { signatureText: _signatureText, ...publicRow } = row;
  return publicRow;
}
