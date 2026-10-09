/** Exact non-rollover allowance increase for the remaining part of a paid period. */
import { ElizaError } from "@elizaos/core";

export function proratedAllowanceIncrease(input: {
  previousUsd: string;
  targetUsd: string;
  periodStartMs: number;
  periodEndMs: number;
  effectiveAtMs: number;
}): string {
  const canonical = /^(0|[1-9]\d*)\.\d{6}$/;
  const { periodStartMs: start, periodEndMs: end, effectiveAtMs: effective } = input;
  if (
    !canonical.test(input.previousUsd) ||
    !canonical.test(input.targetUsd) ||
    ![start, end, effective].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    start >= end ||
    effective < start ||
    effective >= end
  ) {
    throw new ElizaError(
      "Allowance proration requires canonical amounts and an effective time inside the paid period",
      { code: "SUBSCRIPTION_ALLOWANCE_PRORATION_INVALID" },
    );
  }
  const delta =
    BigInt(input.targetUsd.replace(".", "")) - BigInt(input.previousUsd.replace(".", ""));
  if (delta <= 0n)
    throw new ElizaError("Allowance proration requires an increase", {
      code: "SUBSCRIPTION_ALLOWANCE_PRORATION_INVALID",
    });
  // Floor only once, at the final micro-dollar. Floating-point ratios never enter the ledger.
  const micros = (delta * BigInt(end - effective)) / BigInt(end - start);
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
}
