import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SolanaParsedTransaction } from "../helius";
import { parseSolanaTransaction } from "../parsers/transaction";
import { analyzeWalletDeFi } from "./defi";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string) {
  const raw = readFileSync(
    path.join(here, "__fixtures__", name),
    "utf8",
  );
  const transactions = JSON.parse(raw) as SolanaParsedTransaction[];
  return transactions.map(parseSolanaTransaction);
}

describe("analyzeWalletDeFi", () => {
  it("detects 50 Marinade interactions for the Marinade treasury wallet", () => {
    const transactions = loadFixture(
      "marinade-treasury-transactions.json",
    );

    const result = analyzeWalletDeFi(transactions, "solana");

    expect(result.protocolCount).toBe(1);
    expect(result.protocols).toHaveLength(1);
    expect(result.protocols[0].protocol).toBe("Marinade Finance");
    expect(result.protocols[0].interactionCount).toBe(50);
    expect(result.profile).toBe("casual_user");
  });

  it("detects Raydium AMM V4 (8) and Jupiter (1, via inner instructions only)", () => {
    const transactions = loadFixture(
      "jupiter-inner-instructions-wallet-transactions.json",
    );

    const result = analyzeWalletDeFi(transactions, "solana");

    const byName = new Map(
      result.protocols.map((protocol) => [
        protocol.protocol,
        protocol.interactionCount,
      ]),
    );

    expect(byName.get("Raydium AMM V4")).toBe(8);
    expect(byName.get("Jupiter Aggregator V6")).toBe(1);
  });
});
