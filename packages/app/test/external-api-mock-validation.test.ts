// Ratchet gate for external-API mock validation.
//
// The keyless ui-smoke lane mocks external-API BFF endpoints with inline fixtures
// in test/ui-smoke/helpers.ts. A mock is only trustworthy when the plugin's BFF
// parser is validated against a REAL recorded provider response + a live drift
// check (see docs/EXTERNAL_API_MOCK_VALIDATION.md).
//
// This gate enforces:
//   1. every API marked "validated" keeps its recorded-contract + live-drift tests
//      (file existence — they can't silently disappear), and
//   2. the unvalidated-debt set only shrinks (a ceiling that is the forcing
//      function to pay it down, mirroring the other coverage ratchets).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

/** External-API view plugins whose BFF parser is validated against the real API. */
const VALIDATED: Readonly<Record<string, string>> = {
  polymarket: "plugins/plugin-polymarket-app/src",
  hyperliquid: "plugins/plugin-hyperliquid-app/src",
};

/**
 * External-API mocks not yet recorded-replay validated. RATCHET: may only shrink.
 * To remove one: make the plugin's provider call injectable, add
 * routes.contract.test.ts + routes.real.test.ts, then delete it here and lower the
 * ceiling.
 */
const DEBT: Readonly<Record<string, string>> = {
  shopify:
    "Customer fields fixed against the real 2025-04 schema, but shopifyGql is not " +
    "injectable so there is no recorded-replay contract test yet.",
  vincent:
    "Only the unconfigured connected:false path is exercised; the real OAuth/" +
    "profile response shape is unvalidated.",
  wallet:
    "Inline DTO fixtures for balances/nfts/rpc with no recorded-real tie.",
};

const MAX_DEBT = 3;

describe("external-API mock validation ratchet", () => {
  it("every validated API keeps its recorded-contract + live-drift tests", () => {
    const missing: string[] = [];
    for (const [api, dir] of Object.entries(VALIDATED)) {
      for (const file of ["routes.contract.test.ts", "routes.real.test.ts"]) {
        const full = path.join(REPO_ROOT, dir, file);
        if (!existsSync(full)) missing.push(`${api}: ${dir}/${file}`);
      }
      const recordedDir = path.join(REPO_ROOT, dir, "__fixtures__");
      if (!existsSync(recordedDir)) {
        missing.push(`${api}: ${dir}/__fixtures__ (recorded real responses)`);
      }
    }
    expect(
      missing,
      "A validated external-API mock lost its real-validation harness.",
    ).toEqual([]);
  });

  it("unvalidated-debt set only shrinks", () => {
    const debt = Object.keys(DEBT);
    expect(
      debt.length,
      `external-API mock debt (${debt.length}) exceeds its ceiling (${MAX_DEBT}). ` +
        `Validate one (recorded + live contract test) instead of adding more.`,
    ).toBeLessThanOrEqual(MAX_DEBT);

    const both = debt.filter((api) => api in VALIDATED);
    expect(
      both,
      `These APIs are both validated and listed as debt — remove from DEBT: ${both.join(", ")}`,
    ).toEqual([]);
  });
});
