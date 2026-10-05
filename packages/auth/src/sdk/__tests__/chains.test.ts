import { describe, expect, test } from "bun:test";
import { getExplorerTxLink } from "../../contracts/index";
import {
  CHAINS,
  chainFromCaip2,
  chainFromNumeric,
  fromCaip2,
  SUPPORTED_CHAINS,
  toCaip2,
} from "../index";

describe("public chain contracts", () => {
  test("every advertised chain round-trips through SDK identifiers", () => {
    for (const id of Object.values(SUPPORTED_CHAINS)) {
      const chain = chainFromNumeric(id);
      expect(chain).toBeDefined();
      if (!chain) throw new Error(`Missing chain ${id}`);
      expect(chainFromCaip2(toCaip2(id) ?? "")).toEqual(chain);
      expect(fromCaip2(chain.caip2)).toBe(id);
    }
    expect(new Set(Object.values(CHAINS).map((chain) => chain.family))).toEqual(
      new Set(["evm", "solana", "bitcoin", "monero"]),
    );
  });

  test("unknown and prototype names are not chain identities", () => {
    for (const name of ["constructor", "__proto__", "toString", "unknown"]) {
      expect(chainFromCaip2(name)).toBeUndefined();
      expect(fromCaip2(name)).toBeUndefined();
    }
  });

  test("explorer links preserve the selected network", () => {
    expect(getExplorerTxLink(102, "transaction")).toBe(
      "https://explorer.solana.com/tx/transaction?cluster=devnet",
    );
    expect(getExplorerTxLink(202, "transaction")).toBe(
      "https://mempool.space/testnet/tx/transaction",
    );
    expect(getExplorerTxLink(-1, "transaction")).toBeUndefined();
  });
});
