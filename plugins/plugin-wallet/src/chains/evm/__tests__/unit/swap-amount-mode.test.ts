/**
 * Unit tests for `buildSwapDetails`'s relative-amount resolution
 * (absolute/half/max/percent → concrete token amount from wallet balance).
 * The intent-extraction LLM call is mocked to return fixed JSON so each case
 * isolates the arithmetic and validation, not model behavior.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSwapDetails } from "../../actions/swap";
import type { WalletProvider } from "../../providers/wallet";

// Control the raw LLM output so we can assert the structured amountMode →
// absolute-amount resolution in isolation from any model call.
const runIntentModel = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("../../../../utils/intent-trajectory", () => ({
  runIntentModel: (...args: unknown[]) => runIntentModel(...args),
}));

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// base mainnet native balance, as a decimal string (the shape getWalletBalances returns)
const BASE_BALANCE = "2"; // 2.0 ETH

function createWalletProvider(
  balances: Record<string, string> = { base: BASE_BALANCE }
): WalletProvider {
  return {
    chains: { base },
    getSupportedChains: () => ["base"],
    getChainConfigs: () => base,
    getWalletBalances: async () => balances,
  } as unknown as WalletProvider;
}

function createRuntime(): IAgentRuntime {
  const state = {} as State;
  return {
    composeState: vi.fn(async () => state),
  } as unknown as IAgentRuntime;
}

const message = { content: { text: "swap stuff" } } as Memory;

function llmJson(obj: Record<string, unknown>): void {
  runIntentModel.mockResolvedValue(JSON.stringify(obj));
}

describe("buildSwapDetails amountMode resolution", () => {
  beforeEach(() => {
    runIntentModel.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through an absolute amount unchanged", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "absolute",
      amount: "0.5",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider()
    );

    expect(details.amount).toBe("0.5");
    expect(details.chain).toBe("base");
    expect(details.fromToken).toBe(WETH);
    expect(details.toToken).toBe(USDC);
  });

  it("treats a missing/unknown amountMode as absolute", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amount: "1.25",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider()
    );

    expect(details.amount).toBe("1.25");
  });

  it("resolves half to balance / 2", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "half",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider({ base: "2" })
    );

    expect(details.amount).toBe("1"); // 2 / 2
  });

  it("resolves max to balance * 0.9 (gas reserve)", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "max",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider({ base: "10" })
    );

    expect(details.amount).toBe("9"); // 10 * 0.9
  });

  it("resolves percent to balance * amountPercent / 100", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "percent",
      amountPercent: 30,
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider({ base: "10" })
    );

    expect(details.amount).toBe("3"); // 10 * 30 / 100
  });

  it("accepts a numeric percent supplied as a string", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "percent",
      amountPercent: "25",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider({ base: "8" })
    );

    expect(details.amount).toBe("2"); // 8 * 25 / 100
  });

  it("throws INVALID_PARAMS when the chain balance is unknown for a relative mode", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "half",
      chain: "base",
    });

    await expect(
      buildSwapDetails(
        {} as State,
        message,
        createRuntime(),
        // no balance entry for "base"
        createWalletProvider({})
      )
    ).rejects.toThrow(/unknown balance/i);
  });

  it("throws INVALID_PARAMS when percent is out of range (0)", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "percent",
      amountPercent: 0,
      chain: "base",
    });

    await expect(
      buildSwapDetails({} as State, message, createRuntime(), createWalletProvider({ base: "5" }))
    ).rejects.toThrow(/between 1 and 100/i);
  });

  it("throws INVALID_PARAMS when percent is out of range (150)", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "percent",
      amountPercent: 150,
      chain: "base",
    });

    await expect(
      buildSwapDetails({} as State, message, createRuntime(), createWalletProvider({ base: "5" }))
    ).rejects.toThrow(/between 1 and 100/i);
  });

  it("throws INVALID_PARAMS when percent mode omits amountPercent", async () => {
    llmJson({
      inputToken: WETH,
      outputToken: USDC,
      amountMode: "percent",
      chain: "base",
    });

    await expect(
      buildSwapDetails({} as State, message, createRuntime(), createWalletProvider({ base: "5" }))
    ).rejects.toThrow(/between 1 and 100/i);
  });
});
