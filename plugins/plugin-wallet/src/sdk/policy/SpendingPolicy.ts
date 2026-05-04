/**
 * SpendingPolicy — Programmable spending guardrails for AI agents.
 *
 * Beats PolicyLayer.com to market with:
 *   - MerchantAllowlist  — allowlist-only merchant enforcement
 *   - RollingSpendCap    — time-windowed spend limits
 *   - DraftThenApprove   — human-in-the-loop for large transactions
 *   - AuditTrail         — immutable local log of every payment attempt
 *   - FailClosed         — policy errors always reject, never approve
 *
 * @module policy/SpendingPolicy
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A payment the agent wants to make. */
export interface PaymentIntent {
  /** Merchant contract address or domain (e.g. "0xABC..." or "api.example.com") */
  merchant: string;
  /** Amount in the smallest token unit (e.g. USDC micro-cents = 6 decimals). Use number for JS safety in tests; real on-chain code passes BigInt via adapter. */
  amount: number;
  /** ISO-8601 timestamp string. Defaults to now if omitted. */
  timestamp?: string;
  /** Optional human-readable label */
  description?: string;
}

export type PolicyStatus = "approved" | "rejected" | "draft";

/** Result returned by SpendingPolicy.check(). */
export interface PolicyResult {
  status: PolicyStatus;
  reason?: string;
  draftId?: string; // populated when status === 'draft'
}

/** A queued draft transaction awaiting approval. */
export interface DraftEntry {
  draftId: string;
  payment: PaymentIntent;
  queuedAt: string; // ISO-8601
  approved: boolean;
  rejected: boolean;
}

/** Immutable record written to the audit log. */
export interface AuditEntry {
  id: string;
  timestamp: string;
  merchant: string;
  amount: number;
  status: PolicyStatus;
  reason?: string;
  draftId?: string;
}

/** Configuration passed to SpendingPolicy constructor. */
export interface SpendingPolicyConfig {
  /**
   * MerchantAllowlist: list of allowed contract addresses or domains.
   * If provided and non-empty, only these merchants are allowed.
   * Pass an empty array [] to disable allowlist enforcement (allow all).
   */
  merchantAllowlist?: string[];

  /**
   * RollingSpendCap: maximum cumulative spend in a rolling time window.
   * Set to undefined to disable.
   */
  rollingCap?: {
    /** Max amount (same units as PaymentIntent.amount) */
    maxAmount: number;
    /** Window size in milliseconds (e.g. 86_400_000 for 24 h) */
    windowMs: number;
  };

  /**
   * DraftThenApprove: payments above this threshold are placed in draft status
   * for human (or another agent) approval rather than executed immediately.
   * Set to undefined to disable.
   */
  draftThreshold?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

// ─── SpendingPolicy ───────────────────────────────────────────────────────────

export class SpendingPolicy {
  private config: SpendingPolicyConfig;
  private allowlist: Set<string>;
  private spendWindow: Array<{ amount: number; ts: number }>; // rolling window entries
  private auditLog: AuditEntry[];
  private drafts: Map<string, DraftEntry>;

  constructor(config: SpendingPolicyConfig) {
    this.config = config;
    this.allowlist = new Set(
      (config.merchantAllowlist ?? []).map((m) => m.toLowerCase()),
    );
    this.spendWindow = [];
    this.auditLog = [];
    this.drafts = new Map();
  }

  // ─── Public Interface ───────────────────────────────────────────────────────

  /**
   * FailClosed: wraps the actual check logic so that ANY unhandled error
   * produces a rejection rather than inadvertently approving a payment.
   */
  async check(payment: PaymentIntent): Promise<PolicyResult> {
    try {
      return await this._check(payment);
    } catch (err: unknown) {
      const reason = `Policy engine error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
      const result: PolicyResult = { status: "rejected", reason };
      await this.log(payment, result).catch(() => {
        /* ignore log errors in fail-closed path */
      });
      return result;
    }
  }

  /**
   * Write a payment attempt to the immutable audit log.
   */
  async log(payment: PaymentIntent, result: PolicyResult): Promise<void> {
    const entry: AuditEntry = {
      id: nextId("audit"),
      timestamp: payment.timestamp ?? new Date().toISOString(),
      merchant: payment.merchant,
      amount: payment.amount,
      status: result.status,
      reason: result.reason,
      draftId: result.draftId,
    };
    this.auditLog.push(entry);
  }

  /** Return a copy of the current merchant allowlist. */
  getMerchantAllowlist(): string[] {
    return Array.from(this.allowlist);
  }

  /** Add a merchant address/domain to the allowlist at runtime. */
  addMerchant(address: string): void {
    this.allowlist.add(address.toLowerCase());
  }

  /** Return the full, immutable audit log (copy). */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  // ─── Draft queue management ─────────────────────────────────────────────────

  /** Approve a queued draft by its draftId. Returns false if not found. */
  approveDraft(draftId: string): boolean {
    const draft = this.drafts.get(draftId);
    if (!draft) return false;
    draft.approved = true;
    return true;
  }

  /** Reject a queued draft by its draftId. Returns false if not found. */
  rejectDraft(draftId: string): boolean {
    const draft = this.drafts.get(draftId);
    if (!draft) return false;
    draft.rejected = true;
    return true;
  }

  /** Return all pending (not yet approved or rejected) drafts. */
  getPendingDrafts(): DraftEntry[] {
    return Array.from(this.drafts.values()).filter(
      (d) => !d.approved && !d.rejected,
    );
  }

  /** Return all drafts. */
  getAllDrafts(): DraftEntry[] {
    return Array.from(this.drafts.values());
  }

  // ─── Private Logic ──────────────────────────────────────────────────────────

  private async _check(payment: PaymentIntent): Promise<PolicyResult> {
    // 1. MerchantAllowlist check (only enforced when allowlist is non-empty)
    if (this.allowlist.size > 0) {
      const merchant = payment.merchant.toLowerCase();
      if (!this.allowlist.has(merchant)) {
        const result: PolicyResult = {
          status: "rejected",
          reason: `Merchant "${payment.merchant}" is not on the allowlist.`,
        };
        await this.log(payment, result);
        return result;
      }
    }

    // 2. RollingSpendCap check
    if (this.config.rollingCap) {
      const { maxAmount, windowMs } = this.config.rollingCap;
      const now = Date.now();
      const windowStart = now - windowMs;

      // Purge entries outside the window
      this.spendWindow = this.spendWindow.filter((e) => e.ts >= windowStart);

      const spent = this.spendWindow.reduce((sum, e) => sum + e.amount, 0);
      if (spent + payment.amount > maxAmount) {
        const result: PolicyResult = {
          status: "rejected",
          reason: `Rolling spend cap exceeded: spent ${spent}, cap ${maxAmount}, attempted ${payment.amount}.`,
        };
        await this.log(payment, result);
        return result;
      }
    }

    // 3. DraftThenApprove check
    if (
      this.config.draftThreshold !== undefined &&
      payment.amount >= this.config.draftThreshold
    ) {
      const draftId = nextId("draft");
      const draft: DraftEntry = {
        draftId,
        payment,
        queuedAt: payment.timestamp ?? new Date().toISOString(),
        approved: false,
        rejected: false,
      };
      this.drafts.set(draftId, draft);

      const result: PolicyResult = {
        status: "draft",
        reason: `Amount ${payment.amount} meets or exceeds draft threshold ${this.config.draftThreshold}. Awaiting approval.`,
        draftId,
      };
      await this.log(payment, result);
      return result;
    }

    // 4. Approved — record spend in rolling window
    if (this.config.rollingCap) {
      this.spendWindow.push({ amount: payment.amount, ts: Date.now() });
    }

    const result: PolicyResult = { status: "approved" };
    await this.log(payment, result);
    return result;
  }
}
