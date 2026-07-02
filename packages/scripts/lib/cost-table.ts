/**
 * Cost helpers for the offline trajectory tooling (`trajectory.ts`,
 * `run-cerebras.ts`, `lib/trajectory-validate.ts`).
 *
 * The per-model price table has ONE canonical home:
 * `packages/core/src/features/trajectories/pricing.ts` (versioned via
 * `PRICE_TABLE_ID`). It is re-exported here from source — the same pattern
 * other scripts in this directory use for core imports — so the offline
 * validator always prices calls with the exact table the trajectory
 * recorder used to write `cost_usd`.
 */
export {
  computeCallCostUsd,
  type TokenUsageForCost,
} from "../../core/src/features/trajectories/pricing";

/**
 * Format a cost value for terminal display. Always 4 fractional digits so
 * stage-level lines line up nicely.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$?.????";
  return `$${amount.toFixed(4)}`;
}
