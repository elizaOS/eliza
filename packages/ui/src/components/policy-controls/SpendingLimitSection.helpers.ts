import type { SpendingLimitConfig } from "./types";

export function spendingSummary(config: SpendingLimitConfig): string {
  return `$${config.maxPerTx}/tx · $${config.maxPerDay}/day · $${config.maxPerWeek}/wk`;
}
