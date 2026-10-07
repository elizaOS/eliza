import type { IAgentRuntime } from "@elizaos/core";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletBackendService } from "../services/wallet-backend-service.js";
import type {
  WalletChainHandler,
  WalletRouterContext,
  WalletRouterParams,
} from "../types/wallet-router.js";

vi.mock(
  "@elizaos/core",
  async () => import("../__tests__/core-vitest-mock.js"),
);
vi.mock("./solana/keypairUtils", () => ({
  getWalletKey: vi.fn(),
  getExistingSolanaPublicKey: vi.fn(),
}));
vi.mock("./evm/actions/helpers", () => ({ buildSendTxParams: vi.fn() }));
vi.mock("./evm/actions/swap", () => ({ SwapAction: vi.fn() }));
vi.mock("./evm/actions/transfer", () => ({ TransferAction: vi.fn() }));
vi.mock("./evm/bridge-router", () => ({ routeEvmBridge: vi.fn() }));
vi.mock("./evm/providers/wallet", () => ({ initWalletProvider: vi.fn() }));

import { registerDefaultWalletChainHandlers } from "./registry.js";
import { SOLANA_SERVICE_NAME } from "./solana/constants.js";
import { getExistingSolanaPublicKey } from "./solana/keypairUtils.js";

function unsignedSwapTransaction(): string {
  const payer = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    "base64",
  );
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => "application/json" },
  } as unknown as Response;
}

describe("registered Solana swap quote amount", () => {
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
  const inputMint = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;
  const outputMint = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey;
  const connection = {
    simulateTransaction: vi.fn(async () => ({
      context: { slot: 1 },
      value: {
        err: null,
        logs: [],
        unitsConsumed: 1,
        accounts: null,
        returnData: null,
      },
    })),
    getParsedAccountInfo: vi.fn(async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    })),
    sendTransaction: vi.fn(async () => {
      throw new Error("sendTransaction must not run for a quote-amount test");
    }),
  };
  let handler: WalletChainHandler;
  let context: WalletRouterContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getExistingSolanaPublicKey).mockReturnValue(owner);
    const runtime = {
      character: { settings: { chains: { evm: [] } } },
      getSetting: vi.fn(() => null),
      getService: vi.fn((name: string) =>
        name === SOLANA_SERVICE_NAME
          ? { getConnection: () => connection }
          : null,
      ),
    } as unknown as IAgentRuntime;
    const registered: WalletChainHandler[] = [];
    registerDefaultWalletChainHandlers(
      {
        registerChainHandler: (value: WalletChainHandler) =>
          registered.push(value),
      } as unknown as WalletBackendService,
      runtime,
    );
    const solana = registered.find(
      (value) => value.chainId === "solana-mainnet",
    );
    if (!solana?.simulate)
      throw new Error("Solana simulate was not registered");
    handler = solana;
    context = {
      runtime,
      walletBackend: null,
      walletServices: [],
      tokenDataService: null,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const params = (amount: string, fromToken: string): WalletRouterParams => ({
    subaction: "swap",
    fromToken,
    toToken: outputMint.toBase58(),
    amount,
    slippageBps: 50,
    mode: "simulate",
    dryRun: false,
  });

  async function quoteAmount(
    amount: string,
    fromToken: string,
  ): Promise<string> {
    const swapTransaction = unsignedSwapTransaction();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/quote?")) {
        return jsonResponse({
          inputMint: fromToken,
          inAmount: new URL(url).searchParams.get("amount"),
          outputMint: outputMint.toBase58(),
          outAmount: "1",
          slippageBps: 50,
          routePlan: [],
        });
      }
      if (url.endsWith("/swap")) {
        return jsonResponse({ swapTransaction });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await handler.simulate?.(params(amount, fromToken), context);
    const quoteUrl = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("/quote?"));
    if (!quoteUrl) throw new Error("Jupiter quote was not requested");
    return new URL(quoteUrl).searchParams.get("amount") ?? "";
  }

  it("quotes the exact base units of a 6-decimal input", async () => {
    await expect(quoteAmount("1.25", inputMint.toBase58())).resolves.toBe(
      "1250000",
    );
    expect(connection.sendTransaction).not.toHaveBeenCalled();
  });

  it("quotes exact lamports for a whole SOL input", async () => {
    await expect(quoteAmount("1", "SOL")).resolves.toBe("1000000000");
    expect(connection.getParsedAccountInfo).not.toHaveBeenCalled();
  });

  it.each([
    ["1.0000005", inputMint.toBase58()],
    ["0.0000005", inputMint.toBase58()],
    ["1.0000000005", "SOL"],
    ["0", "SOL"],
  ])(
    "rejects %s before requesting a Jupiter quote",
    async (amount, fromToken) => {
      const fetchMock = vi.fn(async () => {
        throw new Error("Jupiter must not be called for an inexact amount");
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        handler.simulate?.(params(amount, fromToken), context),
      ).rejects.toMatchObject({ code: "SOLANA_SWAP_AMOUNT_INVALID" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(connection.sendTransaction).not.toHaveBeenCalled();
    },
  );
});
