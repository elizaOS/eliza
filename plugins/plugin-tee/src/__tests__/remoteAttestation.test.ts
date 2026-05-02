import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhalaRemoteAttestationProvider } from "../providers/remoteAttestation";

const mockTdxQuote = vi.fn().mockResolvedValue({
  quote: "mock-quote-data",
  replayRtmrs: () => ["rtmr0", "rtmr1", "rtmr2", "rtmr3"],
});
const mockDeriveKey = vi.fn();
const mockConstructorCalls: Array<string | undefined> = [];

vi.mock("@phala/dstack-sdk", () => {
  return {
    TappdClient: class MockTappdClient {
      tdxQuote = mockTdxQuote;
      deriveKey = mockDeriveKey;
      constructor(endpoint?: string) {
        mockConstructorCalls.push(endpoint);
      }
    },
  };
});

describe("PhalaRemoteAttestationProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConstructorCalls.length = 0;
    mockTdxQuote.mockResolvedValue({
      quote: "mock-quote-data",
      replayRtmrs: () => ["rtmr0", "rtmr1", "rtmr2", "rtmr3"],
    });
  });

  describe("constructor", () => {
    it("should initialize with LOCAL mode", () => {
      const _provider = new PhalaRemoteAttestationProvider("LOCAL");
      expect(mockConstructorCalls).toContain("http://localhost:8090");
    });

    it("should initialize with DOCKER mode", () => {
      const _provider = new PhalaRemoteAttestationProvider("DOCKER");
      expect(mockConstructorCalls).toContain("http://host.docker.internal:8090");
    });

    it("should initialize with PRODUCTION mode", () => {
      const _provider = new PhalaRemoteAttestationProvider("PRODUCTION");
      expect(mockConstructorCalls).toContain(undefined);
    });

    it("should throw error for invalid mode", () => {
      expect(() => new PhalaRemoteAttestationProvider("INVALID_MODE")).toThrow("Invalid TEE_MODE");
    });
  });

  describe("generateAttestation", () => {
    let provider: PhalaRemoteAttestationProvider;

    beforeEach(() => {
      provider = new PhalaRemoteAttestationProvider("LOCAL");
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
      mockTdxQuote.mockRejectedValueOnce(mockError);

      const errorProvider = new PhalaRemoteAttestationProvider("LOCAL");
      await expect(errorProvider.generateAttestation("test-data")).rejects.toThrow(
        "Failed to generate TDX Quote"
      );
    });

    it("should pass hash algorithm to tdxQuote when provided", async () => {
      const reportData = "test-report-data";
      const hashAlgorithm = "raw";
      await provider.generateAttestation(reportData, hashAlgorithm);

      expect(mockTdxQuote).toHaveBeenCalledWith(reportData, hashAlgorithm);
    });
  });
});
