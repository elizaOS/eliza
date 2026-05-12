import type {
  IAgentRuntime,
  Memory,
  ProviderResult,
  State,
} from "@elizaos/core";

export type HealthStatus = { ok: true } | { ok: false; reason: string };

/**
 * Typed venue / data-source adapter. Canonical actions dispatch into concrete
 * provider classes registered on the runtime provider registry (Phase 2 wiring).
 *
 * See docs/architecture/wallet-and-trading.md §B.3.
 */
export interface CanonicalProvider {
  readonly name: string;
  readonly contextBudgetTokens: number;

  getContext(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult>;

  healthcheck(runtime: IAgentRuntime): Promise<HealthStatus>;
}
