import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted by vitest before any imports) ────────────────────────────

vi.mock("../../generated/specs/spec-helpers", () => ({
  requireActionSpec: vi.fn((name: string) => ({
    name: `${name}_SOLANA`,
    description:
      "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.",
    similes: [
      "SWAP_SOL",
      "SWAP_TOKENS_SOLANA",
      "TOKEN_SWAP_SOLANA",
      "TRADE_TOKENS_SOLANA",
      "EXCHANGE_TOKENS_SOLANA",
    ],
    examples: [],
  })),
}));

vi.mock("../../generated/prompts/typescript/prompts.js", () => ({
  swapTemplate: "mock swap template {{recentMessages}} {{walletInfo}}",
}));

vi.mock("@elizaos/core", () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  composePromptFromState: vi.fn(() => "composed prompt"),
  parseJSONObjectFromText: vi.fn(),
  ModelType: { TEXT_LARGE: "text_large" },
}));

vi.mock("../../keypairUtils", () => ({
  getWalletKey: vi.fn(),
}));

// ── Imports (use mocked modules) ────────────────────────────────────────────

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { parseJSONObjectFromText } from "@elizaos/core";
import { executeSwap } from "../../actions/swap";

// ── Helpers ─────────────────────────────────────────────────────────────────

const SOLANA_SERVICE_NAME = "chain_solana";

function createMockRuntime(
  opts: { service?: unknown; settings?: Record<string, string> } = {}
): IAgentRuntime {
  const { service = null, settings = {} } = opts;

  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: { name: "TestAgent" },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    setSetting: vi.fn(),
    getService: vi.fn((name: string) => (name === SOLANA_SERVICE_NAME ? service : null)),
    composeState: vi.fn(async () => ({
      agentName: "TestAgent",
      values: {},
    })),
    useModel: vi.fn(async () => "{}"),
    getCache: vi.fn(),
    setCache: vi.fn(),
  } as unknown as IAgentRuntime;
}

function createMockService(walletItems: Array<{ symbol: string; address: string }> = []) {
  return {
    getCachedData: vi.fn(async () => ({
      totalUsd: "100",
      totalSol: "1",
      items: walletItems,
    })),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Swap Action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Metadata ──────────────────────────────────────────────────────────────

  describe("metadata", () => {
    it("should have the correct action name from spec", () => {
      expect(executeSwap.name).toBe("SWAP_SOLANA");
    });

    it("should have a non-empty description", () => {
      expect(typeof executeSwap.description).toBe("string");
      expect(executeSwap.description!.length).toBeGreaterThan(0);
      expect(executeSwap.description).toContain("swap");
    });

    it("should expose similes as a non-empty array", () => {
      expect(Array.isArray(executeSwap.similes)).toBe(true);
      expect(executeSwap.similes!.length).toBeGreaterThan(0);
    });

    it("should include expected simile entries", () => {
      expect(executeSwap.similes).toContain("SWAP_SOL");
      expect(executeSwap.similes).toContain("TOKEN_SWAP_SOLANA");
      expect(executeSwap.similes).toContain("EXCHANGE_TOKENS_SOLANA");
    });

    it("should have examples array", () => {
      expect(Array.isArray(executeSwap.examples)).toBe(true);
    });
  });

  // ── validate() ────────────────────────────────────────────────────────────

  describe("validate", () => {
    it("should return true when SolanaService is registered", async () => {
      const mockService = createMockService();
      const runtime = createMockRuntime({ service: mockService });
      const message = { content: { text: "swap 1 SOL to USDC" } } as unknown as Memory;

      const result = await executeSwap.validate(runtime, message);

      expect(result).toBe(true);
      expect(runtime.getService).toHaveBeenCalledWith(SOLANA_SERVICE_NAME);
    });

    it("should return false when SolanaService is not registered", async () => {
      const runtime = createMockRuntime({ service: null });
      const message = { content: { text: "swap 1 SOL to USDC" } } as unknown as Memory;

      const result = await executeSwap.validate(runtime, message);

      expect(result).toBe(false);
    });

    it("should return false when getService returns undefined", async () => {
      const runtime = createMockRuntime();
      vi.mocked(runtime.getService).mockReturnValue(undefined as never);

      const message = { content: { text: "swap tokens" } } as unknown as Memory;
      const result = await executeSwap.validate(runtime, message);

      expect(result).toBe(false);
    });
  });

  // ── handler() ─────────────────────────────────────────────────────────────

  describe("handler", () => {
    it("should report error when SolanaService is not initialized", async () => {
      const runtime = createMockRuntime({ service: null });
      vi.mocked(runtime.getService).mockReturnValue(null as never);

      const message = { content: { text: "swap tokens" } } as unknown as Memory;
      const callback = vi.fn();

      await executeSwap.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("SolanaService not initialized"),
        })
      );
    });

    it("should ask for amount when parsed response has no amount", async () => {
      const mockService = createMockService([
        { symbol: "SOL", address: "So11111111111111111111111111111111111111112" },
      ]);
      const runtime = createMockRuntime({ service: mockService });
      vi.mocked(runtime.getService).mockReturnValue(mockService as never);

      // Model returns swap details without an amount
      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        inputTokenCA: "So11111111111111111111111111111111111111112",
        outputTokenCA: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      });

      const message = { content: { text: "swap SOL" } } as unknown as Memory;
      const callback = vi.fn();

      await executeSwap.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Please specify the amount you want to swap",
        })
      );
    });

    it("should report error when input token is not in wallet", async () => {
      const mockService = createMockService([
        { symbol: "SOL", address: "So11111111111111111111111111111111111111112" },
      ]);
      const runtime = createMockRuntime({ service: mockService });
      vi.mocked(runtime.getService).mockReturnValue(mockService as never);

      // Token symbol provided but no CA — handler will search wallet
      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        inputTokenSymbol: "UNKNOWN_TOKEN",
        outputTokenCA: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1,
      });

      const message = { content: { text: "swap UNKNOWN_TOKEN" } } as unknown as Memory;
      const callback = vi.fn();

      await executeSwap.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Could not find the input token in your wallet",
        })
      );
    });

    it("should report error when output token is not in wallet", async () => {
      const mockService = createMockService([
        { symbol: "SOL", address: "So11111111111111111111111111111111111111112" },
      ]);
      const runtime = createMockRuntime({ service: mockService });
      vi.mocked(runtime.getService).mockReturnValue(mockService as never);

      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        inputTokenCA: "So11111111111111111111111111111111111111112",
        outputTokenSymbol: "NONEXISTENT",
        amount: 1,
      });

      const message = { content: { text: "swap SOL for NONEXISTENT" } } as unknown as Memory;
      const callback = vi.fn();

      await executeSwap.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Could not find the output token in your wallet",
        })
      );
    });

    it("should report SOL_ADDRESS not configured when swapping SOL without env var", async () => {
      const originalSolAddr = process.env.SOL_ADDRESS;
      delete process.env.SOL_ADDRESS;

      const mockService = createMockService();
      const runtime = createMockRuntime({ service: mockService });
      vi.mocked(runtime.getService).mockReturnValue(mockService as never);

      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        inputTokenSymbol: "SOL",
        outputTokenCA: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1,
      });

      const message = { content: { text: "swap 1 SOL" } } as unknown as Memory;
      const callback = vi.fn();

      await executeSwap.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("SOL_ADDRESS is not configured"),
        })
      );

      // Restore
      if (originalSolAddr !== undefined) {
        process.env.SOL_ADDRESS = originalSolAddr;
      }
    });
  });
});
