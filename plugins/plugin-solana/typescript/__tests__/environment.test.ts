import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { solanaEnvSchema, validateSolanaConfig } from "../environment";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockRuntime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: { name: "TestAgent" },
    getSetting: vi.fn((key: string) => settings[key] ?? undefined),
    setSetting: vi.fn(),
    getService: vi.fn(),
  } as unknown as IAgentRuntime;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Solana Environment Config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── solanaEnvSchema (direct Zod validation) ───────────────────────────────

  describe("solanaEnvSchema", () => {
    it("should accept a valid config with SOLANA_PUBLIC_KEY", () => {
      const config = {
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "100",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept a valid config with SOLANA_SECRET_SALT only", () => {
      const config = {
        SOLANA_SECRET_SALT: "my-secret-salt-value",
        SLIPPAGE: "50",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept config with both SOLANA_PRIVATE_KEY and SOLANA_PUBLIC_KEY", () => {
      const config = {
        SOLANA_PRIVATE_KEY: "5SomeBase58PrivateKeyString",
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "200",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should reject config missing SLIPPAGE", () => {
      const config = {
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject config missing SOLANA_RPC_URL", () => {
      const config = {
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "100",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject config with empty SLIPPAGE", () => {
      const config = {
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject config with empty SOLANA_RPC_URL", () => {
      const config = {
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "100",
        SOLANA_RPC_URL: "",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should allow SOLANA_SECRET_SALT to be optional", () => {
      const config = {
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "100",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      };

      const parsed = solanaEnvSchema.safeParse(config);
      expect(parsed.success).toBe(true);
    });

    it("should preserve parsed values accurately", () => {
      const config = {
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "150",
        SOLANA_RPC_URL: "https://custom-rpc.example.com",
        SOLANA_SECRET_SALT: "salt123",
      };

      const result = solanaEnvSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLIPPAGE).toBe("150");
        expect(result.data.SOLANA_RPC_URL).toBe("https://custom-rpc.example.com");
      }
    });
  });

  // ── validateSolanaConfig (runtime integration) ────────────────────────────

  describe("validateSolanaConfig", () => {
    it("should resolve with parsed config for valid runtime settings", async () => {
      const runtime = createMockRuntime({
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "100",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      });

      const config = await validateSolanaConfig(runtime);

      expect(config.SLIPPAGE).toBe("100");
      expect(config.SOLANA_RPC_URL).toBe("https://api.mainnet-beta.solana.com");
    });

    it("should call runtime.getSetting for each expected key", async () => {
      const runtime = createMockRuntime({
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "100",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      });

      await validateSolanaConfig(runtime);

      expect(runtime.getSetting).toHaveBeenCalledWith("SLIPPAGE");
      expect(runtime.getSetting).toHaveBeenCalledWith("SOLANA_RPC_URL");
      expect(runtime.getSetting).toHaveBeenCalledWith("SOLANA_PUBLIC_KEY");
    });

    it("should throw when required settings are missing", async () => {
      const runtime = createMockRuntime({});

      await expect(validateSolanaConfig(runtime)).rejects.toThrow(
        "Solana configuration validation failed"
      );
    });

    it("should throw with descriptive message mentioning SLIPPAGE when missing", async () => {
      const runtime = createMockRuntime({
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      });

      await expect(validateSolanaConfig(runtime)).rejects.toThrow(/SLIPPAGE|Slippage/);
    });

    it("should throw with descriptive message mentioning RPC URL when missing", async () => {
      const runtime = createMockRuntime({
        SOLANA_PUBLIC_KEY: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        SLIPPAGE: "100",
      });

      await expect(validateSolanaConfig(runtime)).rejects.toThrow(/RPC|rpc/i);
    });

    it("should accept config with SOLANA_SECRET_SALT as alternative to public key", async () => {
      const runtime = createMockRuntime({
        SOLANA_SECRET_SALT: "my-salt",
        SLIPPAGE: "100",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
      });

      const config = await validateSolanaConfig(runtime);
      expect(config.SLIPPAGE).toBe("100");
    });
  });
});
