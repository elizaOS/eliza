/**
 * PaymentRouter — Three-rail payment architecture.
 *
 * Routes payments across three rails:
 *   1. **x402** (crypto-native) — on-chain USDC payments via the x402 protocol. Optimal for
 *      micropayments, autonomous agents, and scenarios requiring on-chain audit trails.
 *   2. **MPP** (Managed Payment Protocol / Stripe) — fiat-based payments with dispute resolution.
 *      Optimal for larger amounts, supervised agents, and high-frequency session batching.
 *   3. **Google AP2** (Agent Payment Protocol) — Google's managed agent payment rail combining
 *      identity verification and payment in a single flow. Roadmap; activates when Google
 *      publishes the full AP2 spec. Settlement on Base.
 *
 * Routing criteria:
 *   - Transaction amount (micropayments → x402, high-frequency → MPP)
 *   - Session context (ongoing session → MPP for batching efficiency)
 *   - Agent autonomy level (autonomous → x402, supervised → MPP)
 *   - Chain/ecosystem preference (Google ecosystem → AP2, Solana → x402-solana)
 *   - Rail availability (live vs. roadmap)
 *
 * @module router/PaymentRouter
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type PaymentRail = "x402" | "mpp" | "x402-solana" | "google-ap2";

export type RailStatus = "live" | "roadmap" | "disabled";

export interface RailConfig {
  rail: PaymentRail;
  status: RailStatus;
  /** Maximum per-transaction amount in USDC micro-units (6 decimals) */
  maxAmount?: number;
  /** Minimum per-transaction amount in USDC micro-units */
  minAmount?: number;
}

export interface PaymentContext {
  /** Amount in USDC micro-units (6 decimals). e.g. 1_000_000 = $1.00 */
  amount: number;
  /** Recipient address or merchant domain */
  recipient: string;
  /** Whether this payment is part of an active session with repeated transactions */
  isSessionContext?: boolean;
  /** Number of transactions in the current session (if applicable) */
  sessionTxCount?: number;
  /** Whether the agent is operating autonomously (no human in loop) */
  autonomous?: boolean;
  /** Preferred chain, if any */
  preferredChain?: "base" | "solana" | "google-ap2";
}

export interface RoutingDecision {
  rail: PaymentRail;
  reason: string;
  /** Estimated cost overhead (basis points) */
  estimatedOverheadBps: number;
  /** Whether this rail is currently live */
  isLive: boolean;
}

// ─── Default Rail Configuration ───────────────────────────────────────────────

const DEFAULT_RAILS: RailConfig[] = [
  {
    rail: "x402",
    status: "live",
    minAmount: 1_000, // $0.001 minimum
    maxAmount: 100_000_000, // $100 max per tx (soft limit)
  },
  {
    rail: "mpp",
    status: "live",
    minAmount: 100_000, // $0.10 minimum (Stripe floor)
    maxAmount: 10_000_000_000, // $10,000 max
  },
  {
    rail: "x402-solana",
    status: "roadmap",
  },
  {
    rail: "google-ap2",
    status: "roadmap",
    minAmount: 1_000, // $0.001 minimum (aligned with x402)
    maxAmount: 50_000_000, // $50 max per tx (conservative until spec finalized)
  },
];

// ─── Router ───────────────────────────────────────────────────────────────────

export class PaymentRouter {
  private rails: RailConfig[];
  /** Amount threshold (micro-units) below which x402 is preferred. Default: $1.00 */
  private microPaymentThreshold: number;
  /** Session tx count above which MPP is preferred for batching. Default: 5 */
  private highFrequencyThreshold: number;

  constructor(options?: {
    rails?: RailConfig[];
    microPaymentThreshold?: number;
    highFrequencyThreshold?: number;
  }) {
    this.rails = options?.rails ?? DEFAULT_RAILS;
    this.microPaymentThreshold = options?.microPaymentThreshold ?? 1_000_000; // $1.00
    this.highFrequencyThreshold = options?.highFrequencyThreshold ?? 5;
  }

  /**
   * Select the optimal payment rail for a given context.
   */
  route(context: PaymentContext): RoutingDecision {
    const {
      amount,
      isSessionContext,
      sessionTxCount,
      autonomous,
      preferredChain,
    } = context;

    // If Google AP2 rail is live and context indicates Google ecosystem preference
    // Google AP2 (Agent Payment Protocol) — Google's native agent payment rail
    // Currently roadmap; will activate when Google publishes the full AP2 spec
    const googleRail = this.getRail("google-ap2");
    if (googleRail?.status === "live" && preferredChain === "base") {
      // Google AP2 routes through Base for on-chain settlement
      // When live, AP2 provides Google-managed identity + payment in a single flow
      return {
        rail: "google-ap2",
        reason: "Google AP2 rail — managed identity + payment bundle",
        estimatedOverheadBps: 100, // Estimated Google platform fee
        isLive: true,
      };
    }

    // If Solana is explicitly preferred and x402-solana is available
    if (preferredChain === "solana") {
      const solanaRail = this.getRail("x402-solana");
      if (solanaRail?.status === "live") {
        return {
          rail: "x402-solana",
          reason: "Preferred chain: Solana x402",
          estimatedOverheadBps: 0,
          isLive: true,
        };
      }
      // Solana not yet live — fall through to other rails
    }

    // Rule 1: High-frequency session context → MPP (batching efficiency)
    if (
      isSessionContext &&
      (sessionTxCount ?? 0) >= this.highFrequencyThreshold
    ) {
      const mppRail = this.getRail("mpp");
      if (mppRail?.status === "live") {
        return {
          rail: "mpp",
          reason: `High-frequency session (${sessionTxCount} txns) — MPP batching is more efficient`,
          estimatedOverheadBps: 290, // Stripe's ~2.9%
          isLive: true,
        };
      }
    }

    // Rule 2: Micropayments + autonomous → x402 (lower overhead, no session needed)
    if (amount < this.microPaymentThreshold && autonomous !== false) {
      const x402Rail = this.getRail("x402");
      if (x402Rail?.status === "live") {
        return {
          rail: "x402",
          reason: `Micropayment ($${(amount / 1_000_000).toFixed(2)}) + autonomous — x402 optimal`,
          estimatedOverheadBps: 0, // x402 has no protocol fee
          isLive: true,
        };
      }
    }

    // Rule 3: Larger amounts or supervised → MPP (better dispute resolution, fiat rails)
    const mppRail = this.getRail("mpp");
    if (mppRail?.status === "live" && amount >= (mppRail.minAmount ?? 0)) {
      return {
        rail: "mpp",
        reason: `Amount $${(amount / 1_000_000).toFixed(2)} — MPP provides fiat rails and dispute resolution`,
        estimatedOverheadBps: 290,
        isLive: true,
      };
    }

    // Default: x402 on Base
    return {
      rail: "x402",
      reason: "Default rail — Base x402",
      estimatedOverheadBps: 0,
      isLive: this.getRail("x402")?.status === "live",
    };
  }

  /**
   * Get all available (live) rails.
   */
  getLiveRails(): RailConfig[] {
    return this.rails.filter((r) => r.status === "live");
  }

  /**
   * Check if a specific rail is available.
   */
  isRailLive(rail: PaymentRail): boolean {
    return this.getRail(rail)?.status === "live";
  }

  private getRail(rail: PaymentRail): RailConfig | undefined {
    return this.rails.find((r) => r.rail === rail);
  }
}
