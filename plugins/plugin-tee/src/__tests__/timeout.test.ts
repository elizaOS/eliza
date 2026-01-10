import { TEEMode } from "@elizaos/core";
import { TappdClient } from "@phala/dstack-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhalaDeriveKeyProvider } from "../providers/deriveKeyProvider";
import { PhalaRemoteAttestationProvider } from "../providers/remoteAttestationProvider";

// Mock TappdClient
vi.mock("@phala/dstack-sdk", () => ({
  TappdClient: vi.fn().mockImplementation(() => ({
    tdxQuote: vi.fn(),
    deriveKey: vi.fn(),
    endpoint: "http://localhost:8090", // Add this
    info: vi.fn().mockResolvedValue({}), // Add this
  })),
}));

describe("TEE Provider Timeout Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PhalaRemoteAttestationProvider", () => {
    it("should handle API timeout during attestation generation", async () => {
      const mockTdxQuote = vi
        .fn()
        .mockRejectedValueOnce(new Error("Request timed out"));

      vi.mocked(TappdClient).mockImplementation(
        () =>
          ({
            tdxQuote: mockTdxQuote,
            deriveKey: vi.fn(),
          }) as unknown as TappdClient
      );

      const provider = new PhalaRemoteAttestationProvider(TEEMode.LOCAL);
      await expect(() =>
        provider.generateAttestation("test-data")
      ).rejects.toThrow("Failed to generate TDX Quote: Request timed out");

      // Verify the call was made once
      expect(mockTdxQuote).toHaveBeenCalledTimes(1);
      expect(mockTdxQuote).toHaveBeenCalledWith("test-data", undefined);
    });

    it("should handle network errors during attestation generation", async () => {
      const mockTdxQuote = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"));

      vi.mocked(TappdClient).mockImplementation(
        () =>
          ({
            tdxQuote: mockTdxQuote,
            deriveKey: vi.fn(),
          }) as unknown as TappdClient
      );

      const provider = new PhalaRemoteAttestationProvider(TEEMode.LOCAL);
      await expect(() =>
        provider.generateAttestation("test-data")
      ).rejects.toThrow("Failed to generate TDX Quote: Network error");

      expect(mockTdxQuote).toHaveBeenCalledTimes(1);
    });

    it("should handle successful attestation generation", async () => {
      const mockQuote = {
        quote: "test-quote",
        replayRtmrs: () => ["rtmr0", "rtmr1", "rtmr2", "rtmr3"],
      };

      const mockTdxQuote = vi.fn().mockResolvedValueOnce(mockQuote);

      vi.mocked(TappdClient).mockImplementation(
        () =>
          ({
            tdxQuote: mockTdxQuote,
            deriveKey: vi.fn(),
          }) as unknown as TappdClient
      );

      const provider = new PhalaRemoteAttestationProvider(TEEMode.LOCAL);
      const result = await provider.generateAttestation("test-data");

      expect(mockTdxQuote).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        quote: "test-quote",
        timestamp: expect.any(Number),
      });
    });
  });

  describe("PhalaDeriveKeyProvider", () => {
    it("should handle API timeout during key derivation", async () => {
      const mockDeriveKey = vi
        .fn()
        .mockRejectedValueOnce(new Error("Request timed out"));

      vi.mocked(TappdClient).mockImplementation(
        () =>
          ({
            tdxQuote: vi.fn(),
            deriveKey: vi.fn(),
          }) as unknown as TappdClient
      );

      const provider = new PhalaDeriveKeyProvider(TEEMode.LOCAL);
      await expect(() =>
        provider.rawDeriveKey("test-path", "test-subject")
      ).rejects.toThrow("Request timed out");

      expect(mockDeriveKey).toHaveBeenCalledTimes(1);
      expect(mockDeriveKey).toHaveBeenCalledWith("test-path", "test-subject");
    });

    it("should handle API timeout during Ed25519 key derivation", async () => {
      const mockDeriveKey = vi
        .fn()
        .mockRejectedValueOnce(new Error("Request timed out"));

      vi.mocked(TappdClient).mockImplementation(
        () =>
          ({
            tdxQuote: vi.fn(),
            deriveKey: vi.fn(),
          }) as unknown as TappdClient
      );

      const provider = new PhalaDeriveKeyProvider(TEEMode.LOCAL);
      await expect(() =>
        provider.deriveEd25519Keypair(
          "test-path",
          "test-subject",
          "test-agent-id"
        )
      ).rejects.toThrow("Request timed out");

      expect(mockDeriveKey).toHaveBeenCalledTimes(1);
    });
  });
});
