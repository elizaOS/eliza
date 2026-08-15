/**
 * Proves `credits.ts` and `organization-inference-admission.ts` actually call
 * `resolveCostBuffer()` at module load, not just that the helper validates in
 * isolation. `CREDIT_COST_BUFFER=0.5` is accepted by the old bare
 * `Number(process.env.CREDIT_COST_BUFFER) || 1.5` production code (0.5 is
 * truthy and finite) but rejected by the fixed validator (minimum is 1, since
 * 1 means no buffer). If either module bypassed the validator, this import
 * would succeed with COST_BUFFER=0.5 instead of throwing.
 */

import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.CREDIT_COST_BUFFER = "0.5";

describe("COST_BUFFER wiring", () => {
  test("credits.ts throws at import when CREDIT_COST_BUFFER is below the validated minimum", async () => {
    await expect(import("../credits")).rejects.toThrow(
      /INVALID_CREDIT_COST_BUFFER|CREDIT_COST_BUFFER must be a canonical decimal number/,
    );
  });

  test("organization-inference-admission.ts (which imports COST_BUFFER from credits.ts) also throws", async () => {
    await expect(import("../organization-inference-admission")).rejects.toThrow(
      /INVALID_CREDIT_COST_BUFFER|CREDIT_COST_BUFFER must be a canonical decimal number/,
    );
  });
});
