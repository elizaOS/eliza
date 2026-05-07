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

    // Global per-request check
    if (amount > this.globalPerRequestMax) {
      return {
        allowed: false,
        reason: `Amount ${amount} exceeds global per-request max ${this.globalPerRequestMax}`,
      };
    }

    // Global daily check
    if (this.globalDailySpend + amount > this.globalDailyLimit) {
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
      const serviceDailySpend = this.dailySpend.get(service) ?? 0n;
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
   * Record a completed payment.
   */
  recordPayment(log: X402TransactionLog): void {
    this.maybeResetDaily();
    this.transactionLog.push(log);

    if (log.success) {
      const service = log.service;
      this.dailySpend.set(
        service,
        (this.dailySpend.get(service) ?? 0n) + log.amount,
      );
      this.globalDailySpend += log.amount;
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
