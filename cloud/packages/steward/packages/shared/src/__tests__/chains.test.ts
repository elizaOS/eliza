import { describe, expect, it } from "bun:test";
import { CHAINS, chainFromCaip2, chainFromNumeric, fromCaip2, toCaip2 } from "../index";

// ─── CHAINS registry ─────────────────────────────────────────────────────────

describe("CHAINS registry", () => {
  it("contains all expected EVM chains", () => {
    expect(CHAINS["eip155:1"]).toBeDefined();
    expect(CHAINS["eip155:56"]).toBeDefined();
    expect(CHAINS["eip155:97"]).toBeDefined();
    expect(CHAINS["eip155:137"]).toBeDefined();
    expect(CHAINS["eip155:8453"]).toBeDefined();
    expect(CHAINS["eip155:42161"]).toBeDefined();
    expect(CHAINS["eip155:84532"]).toBeDefined();
  });

  it("contains Solana mainnet and devnet", () => {
    expect(CHAINS["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]).toBeDefined();
    expect(CHAINS["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]).toBeDefined();
  });

  it("has correct metadata for Base", () => {
    const chain = CHAINS["eip155:8453"];
    expect(chain.numericId).toBe(8453);
    expect(chain.family).toBe("evm");
    expect(chain.name).toBe("Base");
    expect(chain.symbol).toBe("ETH");
    expect(chain.testnet).toBe(false);
  });

  it("has correct metadata for Base Sepolia (testnet)", () => {
    const chain = CHAINS["eip155:84532"];
    expect(chain.numericId).toBe(84532);
    expect(chain.family).toBe("evm");
    expect(chain.testnet).toBe(true);
  });

  it("has correct metadata for Solana mainnet", () => {
    const chain = CHAINS["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];
    expect(chain.numericId).toBe(101);
    expect(chain.family).toBe("solana");
    expect(chain.name).toBe("Solana");
    expect(chain.symbol).toBe("SOL");
    expect(chain.testnet).toBe(false);
  });

  it("has correct metadata for Solana devnet (testnet)", () => {
    const chain = CHAINS["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"];
    expect(chain.numericId).toBe(102);
    expect(chain.family).toBe("solana");
    expect(chain.testnet).toBe(true);
  });

  it("each entry has its caip2 field matching the registry key", () => {
    for (const [key, chain] of Object.entries(CHAINS)) {
      expect(chain.caip2).toBe(key);
    }
  });
});

// ─── toCaip2 ─────────────────────────────────────────────────────────────────

describe("toCaip2", () => {
  it("converts Ethereum mainnet chainId to CAIP-2", () => {
    expect(toCaip2(1)).toBe("eip155:1");
  });

  it("converts Base chainId to CAIP-2", () => {
    expect(toCaip2(8453)).toBe("eip155:8453");
  });

  it("converts Base Sepolia chainId to CAIP-2", () => {
    expect(toCaip2(84532)).toBe("eip155:84532");
  });

  it("converts BSC chainId to CAIP-2", () => {
    expect(toCaip2(56)).toBe("eip155:56");
  });

  it("converts BSC Testnet chainId to CAIP-2", () => {
    expect(toCaip2(97)).toBe("eip155:97");
  });

  it("converts Polygon chainId to CAIP-2", () => {
    expect(toCaip2(137)).toBe("eip155:137");
  });

  it("converts Arbitrum chainId to CAIP-2", () => {
    expect(toCaip2(42161)).toBe("eip155:42161");
  });

  it("converts Solana mainnet convention ID (101) to CAIP-2", () => {
    expect(toCaip2(101)).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  });

  it("converts Solana devnet convention ID (102) to CAIP-2", () => {
    expect(toCaip2(102)).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("returns undefined for an unknown chain ID", () => {
    expect(toCaip2(999999)).toBeUndefined();
  });
});

// ─── fromCaip2 ───────────────────────────────────────────────────────────────

describe("fromCaip2", () => {
  it("converts eip155:8453 to numeric 8453", () => {
    expect(fromCaip2("eip155:8453")).toBe(8453);
  });

  it("converts eip155:1 to numeric 1", () => {
    expect(fromCaip2("eip155:1")).toBe(1);
  });

  it("converts Solana mainnet CAIP-2 to numeric 101", () => {
    expect(fromCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(101);
  });

  it("converts Solana devnet CAIP-2 to numeric 102", () => {
    expect(fromCaip2("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe(102);
  });

  it("returns undefined for an unknown CAIP-2 string", () => {
    expect(fromCaip2("eip155:99999")).toBeUndefined();
  });

  it("returns undefined for a malformed CAIP-2 string", () => {
    expect(fromCaip2("not-a-caip2")).toBeUndefined();
  });
});

// ─── chainFromNumeric ─────────────────────────────────────────────────────────

describe("chainFromNumeric", () => {
  it("returns the ChainIdentifier for a known chain ID", () => {
    const chain = chainFromNumeric(8453);
    expect(chain).toBeDefined();
    expect(chain?.caip2).toBe("eip155:8453");
    expect(chain?.name).toBe("Base");
  });

  it("returns undefined for an unknown chain ID", () => {
    expect(chainFromNumeric(0)).toBeUndefined();
  });

  it("finds Solana by convention ID 101", () => {
    const chain = chainFromNumeric(101);
    expect(chain).toBeDefined();
    expect(chain?.family).toBe("solana");
    expect(chain?.caip2).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  });
});

// ─── chainFromCaip2 ───────────────────────────────────────────────────────────

describe("chainFromCaip2", () => {
  it("returns the ChainIdentifier for a known CAIP-2 string", () => {
    const chain = chainFromCaip2("eip155:137");
    expect(chain).toBeDefined();
    expect(chain?.numericId).toBe(137);
    expect(chain?.name).toBe("Polygon");
  });

  it("returns undefined for an unknown CAIP-2 string", () => {
    expect(chainFromCaip2("eip155:123456789")).toBeUndefined();
  });

  it("finds Solana devnet by CAIP-2", () => {
    const chain = chainFromCaip2("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(chain).toBeDefined();
    expect(chain?.numericId).toBe(102);
    expect(chain?.testnet).toBe(true);
  });
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe("Round-trip conversions", () => {
  const allNumericIds = Object.values(CHAINS).map((c) => c.numericId);

  it("toCaip2 → fromCaip2 is identity for all supported chains", () => {
    for (const id of allNumericIds) {
      const caip2 = toCaip2(id);
      expect(caip2).toBeDefined();
      expect(fromCaip2(caip2!)).toBe(id);
    }
  });

  it("fromCaip2 → toCaip2 is identity for all supported chains", () => {
    for (const caip2 of Object.keys(CHAINS)) {
      const numericId = fromCaip2(caip2);
      expect(numericId).toBeDefined();
      expect(toCaip2(numericId!)).toBe(caip2);
    }
  });
});
