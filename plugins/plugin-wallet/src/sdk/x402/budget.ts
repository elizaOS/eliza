// [MAX-ADDED] x402 Budget Controls — per-service spending caps and transaction logging
// viem types imported on-demand within class methods
import type {
  X402ClientConfig,
  X402ServiceBudget,
  X402TransactionLog,
} from "./types.js";

/**
 * [MAX-ADDED] In-memory budget tracker for x402 payments.
 * Enforces per-service caps, daily limits, and per-request maximums.
 * On-chain spend limits are ALSO enforced by the AgentWallet contract —
 * this is an additional client-side layer for granular service-level control.
 */
export class X402BudgetTracker {
  private serviceBudgets: Map<string, X402ServiceBudget> = new Map();
  private dailySpend: Map<string, bigint> = new Map(); // service -> today's total
  private globalDailySpend: bigint = 0n;
  private dailyResetTimestamp: number;
  private transactionLog: X402TransactionLog[] = [];
  // Amounts held by payments that passed the check but are not recorded yet
  private reservations: Map<number, { service: string; amount: bigint }> =
    new Map();
  private nextReservationId = 0;

  private globalDailyLimit: bigint;
  private globalPerRequestMax: bigint;

  constructor(config: X402ClientConfig = {}) {
    this.globalDailyLimit =
      config.globalDailyLimit ?? BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFF"); // effectively unlimited
    this.globalPerRequestMax =
      config.globalPerRequestMax ?? BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFF");
    this.dailyResetTimestamp = this.startOfDay();

    if (config.serviceBudgets) {
      for (const budget of config.serviceBudgets) {
        this.serviceBudgets.set(budget.service, budget);
      }
    }
  }

  /**
   * Check if a payment is within budget limits.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  checkBudget(
    service: string,
    amount: bigint,
  ): { allowed: boolean; reason?: string } {
    this.maybeResetDaily();

    if (amount < 0n) {
      return { allowed: false, reason: "Payment amount cannot be negative" };
    }

    // Global per-request check
    if (amount > this.globalPerRequestMax) {
      return {
        allowed: false,
        reason: `Amount ${amount} exceeds global per-request max ${this.globalPerRequestMax}`,
      };
    }

    // Global daily check (in-flight reservations count against the limit)
    if (
      this.globalDailySpend + this.pendingSpend() + amount >
      this.globalDailyLimit
    ) {
      return {
        allowed: false,
        reason: `Would exceed global daily limit ${this.globalDailyLimit}`,
      };
    }

    // Service-specific checks
    const budget = this.findServiceBudget(service);
    if (budget) {
      if (amount > budget.maxPerRequest) {
        return {
          allowed: false,
          reason: `Amount ${amount} exceeds service per-request max ${budget.maxPerRequest} for ${service}`,
        };
      }
      const serviceDailySpend =
        (this.dailySpend.get(service) ?? 0n) + this.pendingSpend(service);
      if (serviceDailySpend + amount > budget.dailyLimit) {
        return {
          allowed: false,
          reason: `Would exceed daily limit ${budget.dailyLimit} for ${service}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check the budget and hold the amount in one synchronous step.
   * Because nothing is awaited between the check and the hold, concurrent
   * payments cannot all pass against the same remaining budget. Pass the
   * returned id to `recordPayment` once paid, or to `releaseReservation` if the
   * payment does not happen.
   */
  reserve(
    service: string,
    amount: bigint,
  ):
    | { allowed: true; reservationId: number }
    | { allowed: false; reason: string } {
    const check = this.checkBudget(service, amount);
    if (!check.allowed) {
      return { allowed: false, reason: check.reason ?? "Budget check failed" };
    }
    const reservationId = ++this.nextReservationId;
    this.reservations.set(reservationId, { service, amount });
    return { allowed: true, reservationId };
  }

  /**
   * Free a held amount without recording a payment. Unknown ids are ignored.
   */
  releaseReservation(reservationId: number): void {
    this.reservations.delete(reservationId);
  }

  /**
   * Record a completed payment. If it was reserved, the hold is replaced by
   * the recorded spend.
   */
  recordPayment(log: X402TransactionLog, reservationId?: number): void {
    if (reservationId !== undefined) this.releaseReservation(reservationId);
    this.maybeResetDaily();
    this.transactionLog.push(log);

    if (log.success) {
      const service = log.service;
      const chargedAmount = log.amount + (log.protocolFee ?? 0n);
      this.dailySpend.set(
        service,
        (this.dailySpend.get(service) ?? 0n) + chargedAmount,
      );
      this.globalDailySpend += chargedAmount;
    }
  }

  /**
   * Get transaction history, optionally filtered.
   */
  getTransactionLog(filter?: {
    service?: string;
    since?: number;
  }): X402TransactionLog[] {
    let logs = this.transactionLog;
    if (filter?.service) {
      logs = logs.filter((l) => l.service === filter.service);
    }
    if (filter?.since !== undefined) {
      const since = filter.since;
      logs = logs.filter((l) => l.timestamp >= since);
    }
    return logs;
  }

  /**
   * Get current daily spend summary.
   */
  getDailySpendSummary(): {
    global: bigint;
    byService: Record<string, bigint>;
    resetsAt: number;
  } {
    this.maybeResetDaily();
    const byService: Record<string, bigint> = {};
    for (const [service, amount] of this.dailySpend) {
      byService[service] = amount;
    }
    return {
      global: this.globalDailySpend,
      byService,
      resetsAt: this.dailyResetTimestamp + 86400,
    };
  }

  /**
   * Add or update a service budget at runtime.
   */
  setServiceBudget(budget: X402ServiceBudget): void {
    this.serviceBudgets.set(budget.service, budget);
  }

  // ─── Internals ───

  private pendingSpend(service?: string): bigint {
    let total = 0n;
    for (const r of this.reservations.values()) {
      if (service === undefined || r.service === service) total += r.amount;
    }
    return total;
  }

  private findServiceBudget(service: string): X402ServiceBudget | undefined {
    // Exact match first, then wildcard
    return this.serviceBudgets.get(service) ?? this.serviceBudgets.get("*");
  }

  private maybeResetDaily(): void {
    const now = this.startOfDay();
    if (now > this.dailyResetTimestamp) {
      this.dailySpend.clear();
      this.globalDailySpend = 0n;
      this.dailyResetTimestamp = now;
    }
  }

  private startOfDay(): number {
    const now = Math.floor(Date.now() / 1000);
    return now - (now % 86400);
  }
}
