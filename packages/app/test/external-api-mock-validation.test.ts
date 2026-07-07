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

/**
 * VALIDATED — recorded-real contract test + a live-drift test (re-fetches the
 * live API). Strongest tier; needs a public API. Each entry lists the required
 * contract + live test files (and a recorded fixture).
 */
const VALIDATED: Readonly<
  Record<string, { contract: string; real: string; fixtures: string }>
> = {
  polymarket: {
    contract: "plugins/plugin-polymarket/src/routes.contract.test.ts",
    real: "plugins/plugin-polymarket/src/routes.real.test.ts",
    fixtures: "plugins/plugin-polymarket/src/__fixtures__",
  },
  hyperliquid: {
    contract: "plugins/plugin-hyperliquid/src/routes.contract.test.ts",
    real: "plugins/plugin-hyperliquid/src/routes.real.test.ts",
    fixtures: "plugins/plugin-hyperliquid/src/__fixtures__",
  },
  coingecko: {
    contract:
      "plugins/plugin-wallet/src/routes/wallet-market-overview.contract.test.ts",
    real: "plugins/plugin-wallet/src/routes/wallet-market-overview.real.test.ts",
    fixtures: "plugins/plugin-wallet/src/routes/__fixtures__",
  },
  calendly: {
    contract: "plugins/plugin-calendly/src/calendly-client.contract.test.ts",
    real: "plugins/plugin-calendly/src/calendly-client.real.test.ts",
    fixtures: "plugins/plugin-calendly/src/__fixtures__",
  },
  "web-search": {
    contract:
      "plugins/plugin-web-search/src/services/webSearchService.contract.test.ts",
    real: "plugins/plugin-web-search/src/services/webSearchService.real.test.ts",
    // SDK-typed fixture (no recorded JSON file); the @tavily/core type IS the
    // recorded contract. Point at the contract test itself as the artifact.
    fixtures:
      "plugins/plugin-web-search/src/services/webSearchService.contract.test.ts",
  },
};

/**
 * CONTRACT_TESTED — a recorded-real contract test only (the parser is proven
 * against a captured real response; no live-drift test yet). Maps each api to its
 * specific contract test file. Promote to VALIDATED by adding a live-drift test.
 * Empty for now (plugin-shopify was removed from the workspace); a newly
 * contract-tested API is added here.
 */
const CONTRACT_TESTED: Readonly<Record<string, string>> = {};

/**
 * UNVALIDATED — inline fixtures only, no recorded-real tie. RATCHET: this set may
 * only SHRINK. Cheapest next wins are the public + injectable ones (coingecko,
 * block explorers). To clear one: capture a real response, add a contract test
 * (move to CONTRACT_TESTED), then a live-drift test (move to VALIDATED).
 */
const DEBT: Readonly<Record<string, string>> = {
  "block-explorers":
    "bscscan/etherscan/solscan reads in plugin-wallet; public " +
    "read endpoints — recorded contract test next.",
  "wallet-rpc":
    "EVM/Solana RPC + token-balance providers use inline DTO fixtures.",
  elevenlabs:
    "api.elevenlabs.io TTS/STT; TTS returns binary audio (no JSON parser to " +
    "validate) — the /voices JSON list is the validation target.",
  google:
    "googleapis.com Calendar/Gmail/Drive/YouTube; OAuth-gated recorded fixtures.",
};

// True count of currently-unvalidated external integrations. The ratchet forbids
// GROWING past this — it must only shrink as APIs are validated.
const MAX_DEBT = 4;

describe("external-API mock validation ratchet", () => {
  it("every validated API keeps its recorded-contract + live-drift tests", () => {
    const missing: string[] = [];
    for (const [api, files] of Object.entries(VALIDATED)) {
      for (const file of [files.contract, files.real, files.fixtures]) {
        if (!existsSync(path.join(REPO_ROOT, file))) {
          missing.push(`${api}: ${file}`);
        }
      }
    }
    expect(
      missing,
      "A validated external-API mock lost its real-validation harness.",
    ).toEqual([]);
  });

  it("every contract-tested API keeps its recorded-contract test", () => {
    const missing = Object.entries(CONTRACT_TESTED)
      .filter(([, file]) => !existsSync(path.join(REPO_ROOT, file)))
      .map(([api, file]) => `${api}: ${file}`);
    expect(
      missing,
      "A contract-tested external-API mock lost its recorded-contract test.",
    ).toEqual([]);
  });

  it("unvalidated-debt set only shrinks and never overlaps a tested tier", () => {
    const debt = Object.keys(DEBT);
    expect(
      debt.length,
      `external-API mock debt (${debt.length}) exceeds its ceiling (${MAX_DEBT}). ` +
        `Validate one (recorded contract test) instead of adding more.`,
    ).toBeLessThanOrEqual(MAX_DEBT);

    const overlap = debt.filter(
      (api) => api in VALIDATED || api in CONTRACT_TESTED,
    );
    expect(
      overlap,
      `These APIs are tested but still listed as debt — remove from DEBT: ${overlap.join(", ")}`,
    ).toEqual([]);
  });
});
