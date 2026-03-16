import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted by vitest before any imports) ────────────────────────────

vi.mock("../../generated/specs/spec-helpers", () => ({
  requireActionSpec: vi.fn((name: string) => ({
    name: `${name}_SOLANA`,
    description:
      "Transfer SOL or SPL tokens to another Solana wallet address.",
    similes: ["SEND_SOL", "PAY_SOLANA", "TRANSFER_TOKENS_SOLANA"],
    examples: [],
  })),
}));

vi.mock("../../generated/prompts/typescript/prompts.js", () => ({
  transferTemplate:
    "mock transfer template {{recentMessages}}",
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

// Mock @solana/spl-token to avoid native module resolution issues in tests
vi.mock("@solana/spl-token", () => ({
  createAssociatedTokenAccountInstruction: vi.fn(),
  createTransferInstruction: vi.fn(),
  getAssociatedTokenAddressSync: vi.fn(),
}));

// ── Imports (use mocked modules) ────────────────────────────────────────────

import { parseJSONObjectFromText } from "@elizaos/core";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { getWalletKey } from "../../keypairUtils";
import transferAction from "../../actions/transfer";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockRuntime(opts: {
  settings?: Record<string, string>;
} = {}): IAgentRuntime {
  const { settings = {} } = opts;

  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: { name: "TestAgent" },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    setSetting: vi.fn(),
    getService: vi.fn(),
    composeState: vi.fn(async () => ({
      agentName: "TestAgent",
      values: {},
    })),
    useModel: vi.fn(async () => "{}"),
    getCache: vi.fn(),
    setCache: vi.fn(),
  } as unknown as IAgentRuntime;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Transfer Action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Metadata ──────────────────────────────────────────────────────────────

  describe("metadata", () => {
    it("should have the correct action name from spec", () => {
      expect(transferAction.name).toBe("TRANSFER_SOLANA");
    });

    it("should have a non-empty description", () => {
      expect(typeof transferAction.description).toBe("string");
      expect(transferAction.description!.length).toBeGreaterThan(0);
    });

    it("should expose similes as a non-empty array", () => {
      expect(Array.isArray(transferAction.similes)).toBe(true);
      expect(transferAction.similes!.length).toBeGreaterThan(0);
    });

    it("should include expected simile entries", () => {
      expect(transferAction.similes).toContain("SEND_SOL");
      expect(transferAction.similes).toContain("PAY_SOLANA");
    });

    it("should have examples array", () => {
      expect(Array.isArray(transferAction.examples)).toBe(true);
    });
  });

  // ── validate() ────────────────────────────────────────────────────────────

  describe("validate", () => {
    it("should always return true (transfer validation is permissive)", async () => {
      const runtime = createMockRuntime();
      const message = { content: { text: "send 1 SOL" } } as unknown as Memory;

      const result = await transferAction.validate(runtime, message);

      expect(result).toBe(true);
    });

    it("should return true regardless of runtime settings", async () => {
      const runtime = createMockRuntime({ settings: {} });
      const message = { content: { text: "transfer tokens" } } as unknown as Memory;

      const result = await transferAction.validate(runtime, message);

      expect(result).toBe(true);
    });
  });

  // ── handler() ─────────────────────────────────────────────────────────────

  describe("handler", () => {
    it("should report error when model returns unparseable content", async () => {
      const runtime = createMockRuntime();
      vi.mocked(parseJSONObjectFromText).mockReturnValue(null);

      const message = { content: { text: "send money" } } as unknown as Memory;
      const state = { agentName: "TestAgent", values: {} } as unknown as State;
      const callback = vi.fn();

      await transferAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Need a valid recipient address and amount"),
        })
      );
    });

    it("should report error when parsed content has no recipient", async () => {
      const runtime = createMockRuntime();
      // Missing `recipient` field → fails isTransferContent
      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        tokenAddress: null,
        amount: "1.5",
      });

      const message = { content: { text: "send 1.5 SOL" } } as unknown as Memory;
      const state = { agentName: "TestAgent", values: {} } as unknown as State;
      const callback = vi.fn();

      await transferAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Need a valid recipient address and amount"),
        })
      );
    });

    it("should report error when parsed content has no amount", async () => {
      const runtime = createMockRuntime();
      // Missing `amount` field → fails isTransferContent
      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        tokenAddress: null,
        recipient: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
      });

      const message = { content: { text: "send SOL" } } as unknown as Memory;
      const state = { agentName: "TestAgent", values: {} } as unknown as State;
      const callback = vi.fn();

      await transferAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Need a valid recipient address and amount"),
        })
      );
    });

    it("should report error when tokenAddress is invalid type", async () => {
      const runtime = createMockRuntime();
      // tokenAddress is a number instead of string|null → fails isTransferContent
      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        tokenAddress: 12345,
        recipient: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        amount: "1",
      });

      const message = { content: { text: "send tokens" } } as unknown as Memory;
      const state = { agentName: "TestAgent", values: {} } as unknown as State;
      const callback = vi.fn();

      await transferAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Need a valid recipient address and amount"),
        })
      );
    });

    it("should report error when wallet keypair is not available", async () => {
      const runtime = createMockRuntime();

      // Valid transfer content
      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        tokenAddress: null,
        recipient: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        amount: "1.5",
      });

      // getWalletKey returns no keypair
      vi.mocked(getWalletKey).mockResolvedValue({ keypair: undefined });

      const message = { content: { text: "send 1.5 SOL" } } as unknown as Memory;
      const state = { agentName: "TestAgent", values: {} } as unknown as State;
      const callback = vi.fn();

      await transferAction.handler(runtime, message, state, {}, callback);

      expect(getWalletKey).toHaveBeenCalledWith(runtime, true);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Need a valid agent address"),
        })
      );
    });

    it("should report transfer failure when getWalletKey throws", async () => {
      const runtime = createMockRuntime();

      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        tokenAddress: null,
        recipient: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        amount: "1.5",
      });

      vi.mocked(getWalletKey).mockRejectedValue(new Error("Invalid private key format"));

      const message = { content: { text: "send 1.5 SOL" } } as unknown as Memory;
      const state = { agentName: "TestAgent", values: {} } as unknown as State;
      const callback = vi.fn();

      await transferAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Transfer failed"),
          content: expect.objectContaining({
            error: expect.stringContaining("Invalid private key format"),
          }),
        })
      );
    });

    it("should pass valid transfer content through to wallet key lookup", async () => {
      const runtime = createMockRuntime();

      vi.mocked(parseJSONObjectFromText).mockReturnValue({
        tokenAddress: null,
        recipient: "9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
        amount: 2,
      });

      // Return undefined to test the "no keypair" branch
      vi.mocked(getWalletKey).mockResolvedValue({ keypair: undefined });

      const message = { content: { text: "send 2 SOL" } } as unknown as Memory;
      const state = { agentName: "TestAgent", values: {} } as unknown as State;
      const callback = vi.fn();

      await transferAction.handler(runtime, message, state, {}, callback);

      // Confirms the content passed isTransferContent and reached getWalletKey
      expect(getWalletKey).toHaveBeenCalledWith(runtime, true);
    });
  });
});
