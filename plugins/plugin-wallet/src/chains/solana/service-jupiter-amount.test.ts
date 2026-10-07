import type { IAgentRuntime } from "@elizaos/core";
import { Keypair } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaService } from "./service";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => "application/json" },
  } as unknown as Response;
}

describe("SolanaService Jupiter quote amount", () => {
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function serviceWith(fetchMock: ReturnType<typeof vi.fn>) {
    const runtime = {
      fetch: fetchMock,
      getSetting: vi.fn((key: string) =>
        key === "SOLANA_RPC_URL" ? "https://api.mainnet-beta.solana.com" : null
      ),
      getServiceLoadPromise: vi.fn(() => new Promise(() => {})),
      getService: vi.fn(() => null),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as IAgentRuntime;
    const service = new SolanaService(runtime);
    return service as unknown as {
      buildJupiterSwapTransaction(params: {
        walletPublicKey: typeof owner;
        inputTokenCA: string;
        outputTokenCA: string;
        amount: BigNumber;
        slippageBps?: number;
      }): Promise<{ swapTransaction: string }>;
    };
  }

  async function quotedAmount(amount: string, inputTokenCA: string): Promise<string> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/quote?")) {
        return jsonResponse({
          inAmount: new URL(url).searchParams.get("amount"),
          outAmount: "1",
          routePlan: [],
        });
      }
      if (url.endsWith("/swap")) {
        return jsonResponse({ swapTransaction: "unsigned" });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const service = serviceWith(fetchMock);
    await service.buildJupiterSwapTransaction({
      walletPublicKey: owner,
      inputTokenCA,
      outputTokenCA: inputTokenCA === SOL ? USDC : SOL,
      amount: new BigNumber(amount),
      slippageBps: 50,
    });
    const quoteUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/quote?"));
    if (!quoteUrl) throw new Error("Jupiter quote was not requested");
    return new URL(quoteUrl).searchParams.get("amount") ?? "";
  }

  it("quotes exact USDC base units", async () => {
    await expect(quotedAmount("1.25", USDC)).resolves.toBe("1250000");
  });

  it("quotes exact lamports for whole SOL", async () => {
    await expect(quotedAmount("1", SOL)).resolves.toBe("1000000000");
  });

  it.each([
    ["1.0000005", USDC],
    ["0.0000005", USDC],
    ["1.0000000005", SOL],
  ])("rejects %s before requesting a quote", async (amount, inputTokenCA) => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Jupiter must not be called for an inexact amount");
    });
    const service = serviceWith(fetchMock);
    await expect(
      service.buildJupiterSwapTransaction({
        walletPublicKey: owner,
        inputTokenCA,
        outputTokenCA: inputTokenCA === SOL ? USDC : SOL,
        amount: new BigNumber(amount),
        slippageBps: 50,
      })
    ).rejects.toMatchObject({ code: "SOLANA_SWAP_AMOUNT_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
