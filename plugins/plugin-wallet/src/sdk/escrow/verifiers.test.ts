import { beforeEach, describe, expect, it, vi } from "vitest";

const encodeAbiParameters = vi.fn((types: unknown, values: unknown[]) => {
  return `0xencoded-${JSON.stringify(values)}` as `0x${string}`;
});
const parseAbiParameters = vi.fn((sig: string) => [sig] as unknown);

vi.mock("viem", () => ({
  encodeAbiParameters,
  parseAbiParameters,
}));

vi.mock("./types.js", () => ({
  VerifierType: undefined,
}));

const {
  resolveVerifierAddress,
  encodeHashVerifierData,
  encodeOptimisticVerifierData,
} = await import("./verifiers.ts");

describe("verifiers", () => {
  beforeEach(() => {
    encodeAbiParameters.mockClear();
    parseAbiParameters.mockClear();
  });

  describe("resolveVerifierAddress", () => {
    it("returns a custom contract address verbatim", () => {
      const addr = "0x1234567890abcdef1234567890abcdef12345678";
      expect(resolveVerifierAddress(addr, 8453)).toBe(addr);
    });

    it("throws for an unknown chain id", () => {
      expect(() => resolveVerifierAddress("optimistic", 1)).toThrow(
        "No verifier addresses configured for chain 1",
      );
    });

    it("throws for a built-in verifier not yet deployed on the chain", () => {
      // Addresses on Base mainnet are pre-deployment zero addresses.
      expect(() => resolveVerifierAddress("optimistic", 8453)).toThrow(
        'Verifier "optimistic" not deployed on chain 8453',
      );
    });
  });

  describe("encodeHashVerifierData", () => {
    it("ABI-encodes the expected hash as bytes32", () => {
      const hash = "0x" + "ab".repeat(32);
      const result = encodeHashVerifierData(hash);
      expect(parseAbiParameters).toHaveBeenCalledWith("bytes32");
      expect(encodeAbiParameters).toHaveBeenCalledWith(["bytes32"], [hash]);
      expect(result).toBe(`0xencoded-${JSON.stringify([hash])}`);
    });
  });

  describe("encodeOptimisticVerifierData", () => {
    it("returns empty bytes for the optimistic verifier", () => {
      expect(encodeOptimisticVerifierData()).toBe("0x");
    });
  });
});
