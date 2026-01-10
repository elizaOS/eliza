/**
 * Tests for the Remote Attestation Provider.
 */

import { TEEMode } from "@elizaos/core";
import { TappdClient } from "@phala/dstack-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhalaRemoteAttestationProvider } from "../providers/remoteAttestation";

// Mock TappdClient
vi.mock("@phala/dstack-sdk", () => ({
  TappdClient: vi.fn().mockImplementation(() => ({
    tdxQuote: vi.fn().mockResolvedValue({
      quote: "mock-quote-data",
      replayRtmrs: () => ["rtmr0", "rtmr1", "rtmr2", "rtmr3"],
    }),
    deriveKey: vi.fn(),
  })),
}));

describe("PhalaRemoteAttestationProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should initialize with LOCAL mode", () => {
      const _provider = new PhalaRemoteAttestationProvider(TEEMode.LOCAL);
      expect(TappdClient).toHaveBeenCalledWith("http://localhost:8090");
    });

    it("should initialize with DOCKER mode", () => {
      const _provider = new PhalaRemoteAttestationProvider(TEEMode.DOCKER);
      expect(TappdClient).toHaveBeenCalledWith("http://host.docker.internal:8090");
    });

    it("should initialize with PRODUCTION mode", () => {
      const _provider = new PhalaRemoteAttestationProvider(TEEMode.PRODUCTION);
      expect(TappdClient).toHaveBeenCalledWith();
    });

    it("should throw error for invalid mode", () => {
      expect(() => new PhalaRemoteAttestationProvider("INVALID_MODE")).toThrow(
        "Invalid TEE_MODE"
      );
    });
  });

  describe("generateAttestation", () => {
    let provider: PhalaRemoteAttestationProvider;

    beforeEach(() => {
      provider = new PhalaRemoteAttestationProvider(TEEMode.LOCAL);
    });

    it("should generate attestation successfully", async () => {
      const reportData = "test-report-data";
      const quote = await provider.generateAttestation(reportData);

      expect(quote).toEqual({
        quote: "mock-quote-data",
        timestamp: expect.any(Number),
      });
    });

    it("should handle errors during attestation generation", async () => {
      const mockError = new Error("TDX Quote generation failed");
      vi.mocked(TappdClient).mockImplementationOnce(
        () =>
          ({
            tdxQuote: vi.fn().mockRejectedValue(mockError),
            deriveKey: vi.fn(),
          }) as unknown as TappdClient
      );

      const errorProvider = new PhalaRemoteAttestationProvider(TEEMode.LOCAL);
      await expect(errorProvider.generateAttestation("test-data")).rejects.toThrow(
        "Failed to generate TDX Quote"
      );
    });

    it("should pass hash algorithm to tdxQuote when provided", async () => {
      const reportData = "test-report-data";
      const hashAlgorithm = "raw";
      await provider.generateAttestation(reportData, hashAlgorithm);

      const client = vi.mocked(TappdClient).mock.results[0].value;
      expect(client.tdxQuote).toHaveBeenCalledWith(reportData, hashAlgorithm);
    });
  });
});

