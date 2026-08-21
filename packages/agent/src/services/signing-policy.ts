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
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  createdAt: number;
}

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  requiresHumanConfirmation: boolean;
  matchedRule: string;
};

function clonePolicy(policy: SigningPolicy): SigningPolicy {
  // Defensive copies keep allow/deny authority inside the evaluator: callers
  // must not be able to change decisions by mutating shared arrays.
  return {
    ...policy,
    allowedChainIds: [...policy.allowedChainIds],
    allowedContracts: [...policy.allowedContracts],
    deniedContracts: [...policy.deniedContracts],
    allowedMethodSelectors: [...policy.allowedMethodSelectors],
  };
}

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
    this.policy = policy ? clonePolicy(policy) : createDefaultPolicy();
  }

  updatePolicy(policy: SigningPolicy): void {
    this.policy = clonePolicy(policy);
  }

  /**
   * `clonePolicy()` already isolates callers from the live arrays; freezing
   * the snapshot additionally makes a mutation attempt throw immediately
   * (in strict-mode/ESM code) rather than silently succeed on a copy that
   * happens to have no effect — surfacing the caller bug instead of masking
   * it (#23228).
   */
  getPolicy(): SigningPolicy {
    const snapshot = clonePolicy(this.policy);
    for (const value of Object.values(snapshot)) {
      if (Array.isArray(value)) {
        Object.freeze(value);
      }
    }
    return Object.freeze(snapshot);
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
      if (txValue < 0n) {
        return {
          allowed: false,
          reason: "Transaction value must not be negative",
          requiresHumanConfirmation: false,
          matchedRule: "value_non_negative",
        };
      }
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
      request.data.toLowerCase() !== "0x"
    ) {
      // Whole-payload validation: a 4-byte selector followed by whole hex
      // bytes. A valid prefix must not smuggle a malformed tail past the
      // allowlist.
      if (!/^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/i.test(request.data)) {
        return {
          allowed: false,
          reason:
            "Calldata must be a complete 4-byte hex selector followed by whole hex bytes",
          requiresHumanConfirmation: false,
          matchedRule: "method_selector_format",
        };
      }

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

  /**
   * Atomically evaluates `request` and, when the policy allows it, reserves
   * the rate-limit slot and replay marker in the same synchronous step as
   * the check. A separate `evaluate()` then later `recordRequest()` call is
   * a TOCTOU race: two concurrent submissions can both call `evaluate()`
   * (e.g. both observe 0/1 hourly) before either has recorded, so both pass
   * a `maxTransactionsPerHour: 1` policy (#23228). JS execution is
   * single-threaded, so doing the check and the record with no `await`
   * between them — as this method does — makes the pair uninterruptible: no
   * other `tryReserve` call can run in between and observe stale state.
   * `evaluate()`/`recordRequest()` stay as separate primitives, unchanged,
   * for read-only previews and for tests that seed history directly.
   *
   * The caller owns the reservation once this returns `allowed: true`; call
   * `release(request.requestId)` on every path where the reservation is not
   * consumed by an actual signed transaction — a failed sign, a rejected or
   * expired human-confirmation request — or the slot and replay marker are
   * gone from the pool forever.
   */
  tryReserve(request: SigningRequest): PolicyDecision {
    const decision = this.evaluate(request);
    if (decision.allowed) {
      this.recordRequest(request.requestId);
    }
    return decision;
  }

  /** Undo a reservation made by `tryReserve()` that the caller did not follow through on. */
  release(requestId: string): void {
    this.processedRequestIds.delete(requestId);
    this.requestLog = this.requestLog.filter((r) => r.requestId !== requestId);
  }
}
