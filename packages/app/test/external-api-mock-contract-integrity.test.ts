/**
 * Validates the recorded and live contract artifacts claimed by external API
 * test fixtures. Historical counts and unvalidated-integration debt are
 * reported elsewhere and do not affect this correctness check.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

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
    // The SDK-typed contract test is the captured shape for this integration.
    fixtures:
      "plugins/plugin-web-search/src/services/webSearchService.contract.test.ts",
  },
};

const CONTRACT_TESTED: Readonly<Record<string, string>> = {};

describe("external API mock contract integrity", () => {
  it("keeps every artifact claimed by a validated API", () => {
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
      "A validated external API mock lost its real validation harness.",
    ).toEqual([]);
  });

  it("keeps every artifact claimed by a contract-tested API", () => {
    const missing = Object.entries(CONTRACT_TESTED)
      .filter(([, file]) => !existsSync(path.join(REPO_ROOT, file)))
      .map(([api, file]) => `${api}: ${file}`);
    expect(
      missing,
      "A contract-tested external API mock lost its recorded contract test.",
    ).toEqual([]);
  });
});
