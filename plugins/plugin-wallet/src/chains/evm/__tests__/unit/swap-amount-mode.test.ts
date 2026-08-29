/**
 * Unit tests for `buildSwapDetails`'s relative-amount resolution
 * (absolute/half/max/percent → concrete token amount). Relative amounts must
 * resolve against the balance of the token being sold: the ERC-20 `fromToken`
 * balance for token inputs, or the native chain balance (with a `max` gas
 * reserve) only when the input is the native asset. Regression coverage for
 * #29930, where a relative ERC-20 swap was sized off the native gas balance.
 * The intent-extraction LLM call is mocked to return fixed JSON so each case
 * isolates the arithmetic and validation, not model behavior.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSwapDetails } from "../../actions/swap";
import { NATIVE_TOKEN_ADDRESS } from "../../constants";
import type { WalletProvider } from "../../providers/wallet";

// Control the raw LLM output so we can assert the structured amountMode →
// absolute-amount resolution in isolation from any model call.
const runIntentModel = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("../../../../utils/intent-trajectory", () => ({
  runIntentModel: (...args: unknown[]) => runIntentModel(...args),
}));

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// base's native asset is ETH; NATIVE names the native basis unambiguously.
const NATIVE = NATIVE_TOKEN_ADDRESS;
const OWNER = "0x1111111111111111111111111111111111111111";

// base mainnet native balance, as a decimal string (the shape getWalletBalances returns)
const BASE_BALANCE = "2"; // 2.0 ETH

// Stubs the on-chain ERC-20 read path (`balanceOf` + `decimals`) used to size
// relative swaps of a token input. `throws` models an unreachable RPC.
interface TokenStub {
  balanceRaw?: bigint;
  decimals?: number;
  throws?: boolean;
}

function createWalletProvider(
  balances: Record<string, string> = { base: BASE_BALANCE },
  tokenStub?: TokenStub
): WalletProvider {
  return {
    chains: { base },
    getSupportedChains: () => ["base"],
    getChainConfigs: () => base,
    getWalletBalances: async () => balances,
    getAddress: () => OWNER,
    getPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (tokenStub?.throws) {
          throw new Error("RPC unavailable");
        }
        if (functionName === "decimals") {
          return tokenStub?.decimals ?? 6;
        }
        if (functionName === "balanceOf") {
          return tokenStub?.balanceRaw ?? 0n;
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
    }),
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

  it("resolves native half to native balance / 2", async () => {
    llmJson({
      inputToken: NATIVE,
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

  it("resolves native max to native balance * 0.9 (gas reserve)", async () => {
    llmJson({
      inputToken: NATIVE,
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

  it("resolves native percent against the native balance", async () => {
    llmJson({
      inputToken: NATIVE,
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

  it("accepts a numeric native percent supplied as a string", async () => {
    llmJson({
      inputToken: NATIVE,
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

  // Regression for #29930: a relative swap of an ERC-20 must resolve against
  // that token's on-chain balance, not the native gas balance. Here the wallet
  // holds only 2 ETH but 500 USDC (6 decimals); 50% of USDC must be 250, not
  // 1 (which is 50% of the native ETH balance the buggy code used).
  it("resolves a token percent against the ERC-20 fromToken balance, not native", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "percent",
      amountPercent: 50,
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider({ base: "2" }, { balanceRaw: 500_000000n, decimals: 6 })
    );

    expect(details.fromToken).toBe(USDC);
    expect(details.amount).toBe("250"); // 50% of 500 USDC, not 50% of 2 ETH ("1")
    expect(details.amount).not.toBe("1");
  });

  it("resolves a token half against the ERC-20 fromToken balance", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "half",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider({ base: "2" }, { balanceRaw: 1000_000000n, decimals: 6 })
    );

    expect(details.amount).toBe("500"); // 1000 USDC / 2
  });

  // A token `max` spends the whole token balance: the 0.9 gas reserve only
  // applies to the native asset, since gas is paid in a different token.
  it("resolves a token max to the full ERC-20 balance (no gas reserve)", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "max",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      createWalletProvider({ base: "2" }, { balanceRaw: 250_000000n, decimals: 6 })
    );

    expect(details.amount).toBe("250"); // full 250 USDC, not 225
  });

  // Magnitude + precision: ERC-20 balances the caller does not control span
  // dust and >1e24-token ranges. The pre-fix float path (`Number(balance) / 2`
  // then `.toString()`) emitted exponential notation there (`"5e-13"`,
  // `"1e+24"`) that `parseUnits` rejects, and lost precision past ~15 digits.
  // These pin the exact-integer path: always plain decimal, always exact.
  it("resolves a dust 18-decimal token half to plain decimal, not exponential", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "half",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      // 1e6 wei of an 18-decimal token = 0.000000000001 token; the old float
      // path halved this to "5e-13", which parseUnits cannot parse.
      createWalletProvider({ base: "2" }, { balanceRaw: 1_000_000n, decimals: 18 })
    );

    expect(details.amount).toBe("0.0000000000005");
    expect(details.amount).not.toMatch(/e/i);
  });

  it("resolves a very large 18-decimal token half to plain decimal, not exponential", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "half",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      // 2e24 whole tokens (18 decimals); the old float path produced "1e+24".
      createWalletProvider({ base: "2" }, { balanceRaw: 2n * 10n ** 42n, decimals: 18 })
    );

    expect(details.amount).toBe("1000000000000000000000000");
    expect(details.amount).not.toMatch(/e/i);
  });

  it("keeps full precision halving an 18-decimal balance past float64's ~15 digits", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "half",
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      // 123456789.123456789012345678 tokens; float halving gives
      // "61728394.561728396" (wrong past 15 digits), exact halving does not.
      createWalletProvider(
        { base: "2" },
        { balanceRaw: 123456789123456789012345678n, decimals: 18 }
      )
    );

    expect(details.amount).toBe("61728394.561728394506172839");
  });

  it("resolves a fractional token percent with exact-integer arithmetic", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "percent",
      amountPercent: 33.33,
      chain: "base",
    });

    const details = await buildSwapDetails(
      {} as State,
      message,
      createRuntime(),
      // 1000 USDC (6 decimals); 33.33% = 333.3 USDC.
      createWalletProvider({ base: "2" }, { balanceRaw: 1000_000000n, decimals: 6 })
    );

    expect(details.amount).toBe("333.3");
    expect(details.amount).not.toMatch(/e/i);
  });

  it("throws INVALID_PARAMS when the ERC-20 fromToken balance cannot be read", async () => {
    llmJson({
      inputToken: USDC,
      outputToken: WETH,
      amountMode: "half",
      chain: "base",
    });

    await expect(
      buildSwapDetails(
        {} as State,
        message,
        createRuntime(),
        createWalletProvider({ base: "2" }, { throws: true })
      )
    ).rejects.toThrow(/failed to read the .* balance/i);
  });

  it("throws INVALID_PARAMS when the native balance is unknown for a relative mode", async () => {
    llmJson({
      inputToken: NATIVE,
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

  it("throws INVALID_PARAMS when native percent is out of range (0)", async () => {
    llmJson({
      inputToken: NATIVE,
      outputToken: USDC,
      amountMode: "percent",
      amountPercent: 0,
      chain: "base",
    });

    await expect(
      buildSwapDetails({} as State, message, createRuntime(), createWalletProvider({ base: "5" }))
    ).rejects.toThrow(/between 1 and 100/i);
  });

  it("throws INVALID_PARAMS when native percent is out of range (150)", async () => {
    llmJson({
      inputToken: NATIVE,
      outputToken: USDC,
      amountMode: "percent",
      amountPercent: 150,
      chain: "base",
    });

    await expect(
      buildSwapDetails({} as State, message, createRuntime(), createWalletProvider({ base: "5" }))
    ).rejects.toThrow(/between 1 and 100/i);
  });

  it("throws INVALID_PARAMS when native percent mode omits amountPercent", async () => {
    llmJson({
      inputToken: NATIVE,
      outputToken: USDC,
      amountMode: "percent",
      chain: "base",
    });

    await expect(
      buildSwapDetails({} as State, message, createRuntime(), createWalletProvider({ base: "5" }))
    ).rejects.toThrow(/between 1 and 100/i);
  });
});
