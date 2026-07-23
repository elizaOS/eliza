/**
 * Guards the embeddings route against reintroducing direct database-backed
 * pricing, ledger, or reservation work ahead of provider dispatch.
 */

import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../v1/embeddings/route.ts", import.meta.url),
).text();

test("embeddings delegates pre-dispatch billing to canonical cache-gated admission", () => {
  expect(source).toContain("admitOrganizationInference({");
  expect(source).toContain("executionCtx,");
  expect(source).toContain("cacheOnly: Boolean(executionCtx)");
});

test("embeddings route does not own legacy synchronous billing fallbacks", () => {
  for (const forbidden of [
    "reserveCredits(",
    "calculateCost(",
    "admitInferenceChargeViaLedger(",
    "writePendingInferenceCharge(",
    "getGateBalanceUsd(",
  ]) {
    expect(source).not.toContain(forbidden);
  }
});
