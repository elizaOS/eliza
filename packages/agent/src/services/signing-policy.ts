/**
 * Transaction signing policy engine.
 * Evaluates requests against chain/contract/value/rate/method/replay rules.
 */

export interface SigningPolicy {
  allowedChainIds: number[]; // empty = allow all
  allowedContracts: string[]; // lowercase; empty = allow all
  deniedContracts: string[]; // checked before allowlist
  maxTransactionValueWei: string; // string for BigInt compat
  maxTransactionsPerHour: number;
  maxTransactionsPerDay: number;
  allowedMethodSelectors: string[]; // 4-byte hex; empty = allow all
  humanConfirmationThresholdWei: string;
  requireHumanConfirmation: boolean;
}

export interface SigningRequest {
  requestId: string;
  chainId: number;
  to: string;
  value: string;
  data: string;
  nonce?: number;
  gasLimit?: string;
  createdAt: number;
}

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  requiresHumanConfirmation: boolean;
  matchedRule: string;
};

export function createDefaultPolicy(): SigningPolicy {
  return {
    allowedChainIds: [],
    allowedContracts: [],
    deniedContracts: [],
    maxTransactionValueWei: "100000000000000000", // 0.1 ETH
    maxTransactionsPerHour: 10,
    maxTransactionsPerDay: 50,
    allowedMethodSelectors: [],
    humanConfirmationThresholdWei: "10000000000000000", // 0.01 ETH
    requireHumanConfirmation: false,
  };
}

export class SigningPolicyEvaluator {
  private policy: SigningPolicy;
  private requestLog: Array<{ requestId: string; timestamp: number }> = [];
  private processedRequestIds = new Set<string>();

  constructor(policy?: SigningPolicy) {
    this.policy = policy ?? createDefaultPolicy();
  }

  updatePolicy(policy: SigningPolicy): void {
    this.policy = policy;
  }

  getPolicy(): SigningPolicy {
    return { ...this.policy };
  }

  evaluate(request: SigningRequest): PolicyDecision {
    // ── Replay protection ────────────────────────────────────────────
    if (this.processedRequestIds.has(request.requestId)) {
      return {
        allowed: false,
        reason: `Replay detected: request ${request.requestId} already processed`,
        requiresHumanConfirmation: false,
        matchedRule: "replay_protection",
      };
    }

    // ── Chain ID ─────────────────────────────────────────────────────
    if (
      this.policy.allowedChainIds.length > 0 &&
      !this.policy.allowedChainIds.includes(request.chainId)
    ) {
      return {
        allowed: false,
        reason: `Chain ${request.chainId} not in allowlist`,
        requiresHumanConfirmation: false,
        matchedRule: "chain_id_allowlist",
      };
    }

    // ── Contract denylist ────────────────────────────────────────────
    const normalizedTo = request.to.toLowerCase();
    if (
      this.policy.deniedContracts.some((c) => c.toLowerCase() === normalizedTo)
    ) {
      return {
        allowed: false,
        reason: `Contract ${request.to} is denylisted`,
        requiresHumanConfirmation: false,
        matchedRule: "contract_denylist",
      };
    }

    // ── Contract allowlist ───────────────────────────────────────────
    if (
      this.policy.allowedContracts.length > 0 &&
      !this.policy.allowedContracts.some(
        (c) => c.toLowerCase() === normalizedTo,
      )
    ) {
      return {
        allowed: false,
        reason: `Contract ${request.to} not in allowlist`,
        requiresHumanConfirmation: false,
        matchedRule: "contract_allowlist",
      };
    }

    // ── Value cap ────────────────────────────────────────────────────
    try {
      const txValue = BigInt(request.value || "0");
      const maxValue = BigInt(this.policy.maxTransactionValueWei);
      if (txValue > maxValue) {
        return {
          allowed: false,
          reason: `Value ${request.value} exceeds max ${this.policy.maxTransactionValueWei}`,
          requiresHumanConfirmation: false,
          matchedRule: "value_cap",
        };
      }
    } catch {
      return {
        allowed: false,
        reason: "Invalid transaction value format",
        requiresHumanConfirmation: false,
        matchedRule: "value_parse_error",
      };
    }

    // ── Method selector ──────────────────────────────────────────────
    if (
      this.policy.allowedMethodSelectors.length > 0 &&
      request.data &&
      request.data.length >= 10
    ) {
      const selector = request.data.substring(0, 10).toLowerCase();
      if (
        !this.policy.allowedMethodSelectors.some(
          (s) => s.toLowerCase() === selector,
        )
      ) {
        return {
          allowed: false,
          reason: `Method selector ${selector} not in allowlist`,
          requiresHumanConfirmation: false,
          matchedRule: "method_selector_allowlist",
        };
      }
    }

    // ── Rate limiting ────────────────────────────────────────────────
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Prune old entries
    this.requestLog = this.requestLog.filter((r) => r.timestamp > oneDayAgo);

    const hourCount = this.requestLog.filter(
      (r) => r.timestamp > oneHourAgo,
    ).length;
    if (hourCount >= this.policy.maxTransactionsPerHour) {
      return {
        allowed: false,
        reason: `Rate limit: ${hourCount}/${this.policy.maxTransactionsPerHour} per hour`,
        requiresHumanConfirmation: false,
        matchedRule: "rate_limit_hourly",
      };
    }

    const dayCount = this.requestLog.filter(
      (r) => r.timestamp > oneDayAgo,
    ).length;
    if (dayCount >= this.policy.maxTransactionsPerDay) {
      return {
        allowed: false,
        reason: `Rate limit: ${dayCount}/${this.policy.maxTransactionsPerDay} per day`,
        requiresHumanConfirmation: false,
        matchedRule: "rate_limit_daily",
      };
    }

    // ── Human confirmation ───────────────────────────────────────────
    let needsHumanConfirmation = this.policy.requireHumanConfirmation;
    if (!needsHumanConfirmation) {
      try {
        const txValue = BigInt(request.value || "0");
        const threshold = BigInt(this.policy.humanConfirmationThresholdWei);
        if (txValue > threshold) {
          needsHumanConfirmation = true;
        }
      } catch {
        // If value parsing fails for confirmation check, require confirmation
        needsHumanConfirmation = true;
      }
    }

    // ── Allowed ──────────────────────────────────────────────────────
    return {
      allowed: true,
      reason: "All policy checks passed",
      requiresHumanConfirmation: needsHumanConfirmation,
      matchedRule: "allowed",
    };
  }

  /** Record after signing completes (for replay + rate tracking). */
  recordRequest(requestId: string): void {
    this.processedRequestIds.add(requestId);
    this.requestLog.push({ requestId, timestamp: Date.now() });

    // Bound replay cache
    if (this.processedRequestIds.size > 10000) {
      const oldest = [...this.processedRequestIds].slice(0, 5000);
      for (const id of oldest) {
        this.processedRequestIds.delete(id);
      }
    }
  }
}
