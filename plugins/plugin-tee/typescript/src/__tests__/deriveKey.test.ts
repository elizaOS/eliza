import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhalaDeriveKeyProvider } from "../providers/deriveKey";

const mockDeriveKey = vi.fn().mockResolvedValue({
  asUint8Array: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
});
const mockTdxQuote = vi.fn().mockResolvedValue({
  quote: "mock-quote-data",
  replayRtmrs: () => ["rtmr0", "rtmr1", "rtmr2", "rtmr3"],
});
const mockConstructorCalls: Array<string | undefined> = [];

vi.mock("@phala/dstack-sdk", () => {
  return {
    TappdClient: class MockTappdClient {
      deriveKey = mockDeriveKey;
      tdxQuote = mockTdxQuote;
      constructor(endpoint?: string) {
        mockConstructorCalls.push(endpoint);
      }
    },
  };
});

vi.mock("@solana/web3.js", () => ({
  Keypair: {
    fromSeed: vi.fn().mockReturnValue({
      publicKey: {
        toBase58: () => "mock-solana-public-key",
      },
    }),
  },
}));

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({
    address: "0xmock-evm-address",
  }),
}));

vi.mock("viem", () => ({
  keccak256: vi.fn().mockReturnValue("0xmock-hash"),
}));

describe("PhalaDeriveKeyProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConstructorCalls.length = 0;
  });

  describe("constructor", () => {
    it("should initialize with LOCAL mode", () => {
      const _provider = new PhalaDeriveKeyProvider("LOCAL");
      expect(mockConstructorCalls).toContain("http://localhost:8090");
    });

    it("should initialize with DOCKER mode", () => {
      const _provider = new PhalaDeriveKeyProvider("DOCKER");
      expect(mockConstructorCalls).toContain("http://host.docker.internal:8090");
    });

    it("should initialize with PRODUCTION mode", () => {
      const _provider = new PhalaDeriveKeyProvider("PRODUCTION");
      expect(mockConstructorCalls).toContain(undefined);
    });

    it("should throw error for invalid mode", () => {
      expect(() => new PhalaDeriveKeyProvider("INVALID_MODE")).toThrow("Invalid TEE_MODE");
    });
  });

  describe("rawDeriveKey", () => {
    let provider: PhalaDeriveKeyProvider;

    beforeEach(() => {
      provider = new PhalaDeriveKeyProvider("LOCAL");
    });

    it("should derive raw key successfully", async () => {
      const path = "test-path";
      const subject = "test-subject";
      const result = await provider.rawDeriveKey(path, subject);

      expect(mockDeriveKey).toHaveBeenCalledWith(path, subject);
      expect(result.key).toBeInstanceOf(Uint8Array);
    });

    it("should throw error when path is missing", async () => {
      await expect(provider.rawDeriveKey("", "subject")).rejects.toThrow(
        "Path and subject are required"
      );
    });

    it("should throw error when subject is missing", async () => {
      await expect(provider.rawDeriveKey("path", "")).rejects.toThrow(
        "Path and subject are required"
      );
    });
  });

  describe("deriveEd25519Keypair", () => {
    let provider: PhalaDeriveKeyProvider;

    beforeEach(() => {
      provider = new PhalaDeriveKeyProvider("LOCAL");
    });

    it("should derive Ed25519 keypair successfully", async () => {
      const path = "test-path";
      const subject = "solana";
      const result = await provider.deriveEd25519Keypair(path, subject, "test-agent-id");

      expect(mockDeriveKey).toHaveBeenCalledWith(path, subject);
      expect(result.keypair.publicKey.toBase58()).toBe("mock-solana-public-key");
      expect(result.attestation.quote).toBe("mock-quote-data");
    });
  });

  describe("deriveEcdsaKeypair", () => {
    let provider: PhalaDeriveKeyProvider;

    beforeEach(() => {
      provider = new PhalaDeriveKeyProvider("LOCAL");
    });

    it("should derive ECDSA keypair successfully", async () => {
      const path = "test-path";
      const subject = "evm";
      const result = await provider.deriveEcdsaKeypair(path, subject, "test-agent-id");

      expect(mockDeriveKey).toHaveBeenCalledWith(path, subject);
      expect(result.keypair.address).toBe("0xmock-evm-address");
      expect(result.attestation.quote).toBe("mock-quote-data");
    });
  });
});
