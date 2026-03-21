/**
 * Remote signing service. Private keys stay on the host;
 * sandboxed agents submit unsigned tx → policy check → sign → return.
 */

import type { SandboxAuditLog } from "../security/audit-log";
import {
  type PolicyDecision,
  type SigningPolicy,
  SigningPolicyEvaluator,
  type SigningRequest,
} from "./signing-policy";

export interface SignerBackend {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
  signTransaction(tx: UnsignedTransaction): Promise<string>;
}

export interface UnsignedTransaction {
  to: string;
  value: string;
  data: string;
  chainId: number;
  nonce?: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface SigningResult {
  success: boolean;
  signature?: string;
  error?: string;
  policyDecision: PolicyDecision;
  humanConfirmed: boolean;
}

export interface PendingApproval {
  requestId: string;
  request: SigningRequest;
  decision: PolicyDecision;
  createdAt: number;
  expiresAt: number;
}

export interface RemoteSigningServiceConfig {
  signer: SignerBackend;
  policy?: SigningPolicy;
  auditLog?: SandboxAuditLog;
  approvalTimeoutMs?: number;
}

export class RemoteSigningService {
  private signer: SignerBackend;
  private policyEvaluator: SigningPolicyEvaluator;
  private auditLog?: SandboxAuditLog;
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalTimeoutMs: number;

  constructor(config: RemoteSigningServiceConfig) {
    this.signer = config.signer;
    this.policyEvaluator = new SigningPolicyEvaluator(config.policy);
    this.auditLog = config.auditLog;
    this.approvalTimeoutMs = config.approvalTimeoutMs ?? 5 * 60 * 1000;
  }

  async getAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  async submitSigningRequest(request: SigningRequest): Promise<SigningResult> {
    // Evaluate policy
    const decision = this.policyEvaluator.evaluate(request);

    this.auditLog?.record({
      type: "signing_request_submitted",
      summary: `Sign request ${request.requestId}: chain=${request.chainId} to=${request.to} value=${request.value}`,
      metadata: {
        requestId: request.requestId,
        chainId: request.chainId,
        to: request.to,
        value: request.value,
        allowed: decision.allowed,
        reason: decision.reason,
      },
      severity: "info",
    });

    if (!decision.allowed) {
      this.auditLog?.record({
        type: "signing_request_rejected",
        summary: `Rejected: ${decision.reason}`,
        metadata: {
          requestId: request.requestId,
          matchedRule: decision.matchedRule,
        },
        severity: "warn",
      });

      return {
        success: false,
        error: decision.reason,
        policyDecision: decision,
        humanConfirmed: false,
      };
    }

    // Check if human confirmation is required
    if (decision.requiresHumanConfirmation) {
      const approval: PendingApproval = {
        requestId: request.requestId,
        request,
        decision,
        createdAt: Date.now(),
        expiresAt: Date.now() + this.approvalTimeoutMs,
      };
      this.pendingApprovals.set(request.requestId, approval);

      return {
        success: false,
        error: "Human confirmation required. Use approve endpoint.",
        policyDecision: decision,
        humanConfirmed: false,
      };
    }

    // Sign the transaction
    return this.executeSign(request, decision, false);
  }

  async approveRequest(requestId: string): Promise<SigningResult> {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) {
      return {
        success: false,
        error: "No pending approval found for this request ID",
        policyDecision: {
          allowed: false,
          reason: "Approval not found",
          requiresHumanConfirmation: false,
          matchedRule: "approval_not_found",
        },
        humanConfirmed: false,
      };
    }

    // Check expiration
    if (Date.now() > approval.expiresAt) {
      this.pendingApprovals.delete(requestId);
      return {
        success: false,
        error: "Approval expired",
        policyDecision: approval.decision,
        humanConfirmed: false,
      };
    }

    this.pendingApprovals.delete(requestId);

    return this.executeSign(approval.request, approval.decision, true);
  }

  rejectRequest(requestId: string): boolean {
    const existed = this.pendingApprovals.has(requestId);
    this.pendingApprovals.delete(requestId);

    if (existed) {
      this.auditLog?.record({
        type: "signing_request_rejected",
        summary: `Human rejected request ${requestId}`,
        metadata: { requestId },
        severity: "info",
      });
    }

    return existed;
  }

  getPendingApprovals(): PendingApproval[] {
    // Clean expired
    const now = Date.now();
    for (const [id, approval] of this.pendingApprovals) {
      if (now > approval.expiresAt) {
        this.pendingApprovals.delete(id);
      }
    }
    return [...this.pendingApprovals.values()];
  }

  updatePolicy(policy: SigningPolicy): void {
    this.policyEvaluator.updatePolicy(policy);
    this.auditLog?.record({
      type: "policy_decision",
      summary: "Signing policy updated",
      severity: "warn",
    });
  }

  getPolicy(): SigningPolicy {
    return this.policyEvaluator.getPolicy();
  }

  private async executeSign(
    request: SigningRequest,
    decision: PolicyDecision,
    humanConfirmed: boolean,
  ): Promise<SigningResult> {
    try {
      const signedTx = await this.signer.signTransaction({
        to: request.to,
        value: request.value,
        data: request.data,
        chainId: request.chainId,
        nonce: request.nonce,
        gasLimit: request.gasLimit,
      });

      // Record for replay protection and rate limiting
      this.policyEvaluator.recordRequest(request.requestId);

      this.auditLog?.record({
        type: "signing_request_approved",
        summary: `Signed request ${request.requestId}: chain=${request.chainId} to=${request.to}`,
        metadata: {
          requestId: request.requestId,
          chainId: request.chainId,
          to: request.to,
          humanConfirmed,
        },
        severity: "info",
      });

      return {
        success: true,
        signature: signedTx,
        policyDecision: decision,
        humanConfirmed,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.auditLog?.record({
        type: "signing_request_rejected",
        summary: `Signing failed for ${request.requestId}: ${errorMsg}`,
        metadata: {
          requestId: request.requestId,
          error: errorMsg,
        },
        severity: "error",
      });

      return {
        success: false,
        error: `Signing failed: ${errorMsg}`,
        policyDecision: decision,
        humanConfirmed,
      };
    }
  }
}
