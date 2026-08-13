/**
 * Unit tests for the non-broadcasting Solana simulation paths added for GH
 * #16613 (`simulateSolanaSwap`, `simulatePumpFunBuy` in `../registry`).
 * `fetch` is faked with real-shaped Jupiter/PumpPortal payloads (including a
 * real base58/base64 `VersionedTransaction` built with `@solana/web3.js`),
 * and `Connection` is a hand-rolled double. The invariant under test is that
 * simulation performs no signing and no broadcast RPCs — `sendTransaction`,
 * `sendRawTransaction`, and `confirmTransaction` are spies that throw if
 * touched, and `VersionedTransaction.prototype.sign` is spied to throw for
 * the dedicated no-signing test. Read-only lookups (`simulateTransaction`,
 * `getParsedAccountInfo` for non-SOL input mints) are permitted and asserted
 * where relevant. No live network or chain is exercised.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WalletRouterContext,
  WalletRouterParams,
} from "../../types/wallet-router";
import { simulatePumpFunBuy, simulateSolanaSwap } from "../registry";
import { SOLANA_SERVICE_NAME } from "../solana/constants";
import { SolanaService } from "../solana/service";

const PUMPFUN_TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";

function buildFakeVersionedTransaction(): VersionedTransaction {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  // simulateTransaction runs with replaceRecentBlockhash: true, so any
  // syntactically valid 32-byte base58 value deserializes fine here.
  const fakeBlockhash = Keypair.generate().publicKey.toBase58();
  const instruction = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: recipient,
    lamports: 1_000,
  });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: fakeBlockhash,
    instructions: [instruction],
  }).compileToV0Message();
  // Deliberately unsigned: VersionedTransaction.serialize() writes the
  // zero-filled signature placeholders the constructor allocates, which is
  // all `simulateTransaction({ sigVerify: false })` needs.
  return new VersionedTransaction(message);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type"
          ? "application/octet-stream"
          : null,
    },
    arrayBuffer: async () => toArrayBuffer(bytes),
  } as unknown as Response;
}

function errorResponse(status: number, body = "trade-local failed"): Response {
  return {
    ok: false,
    status,
    text: async () => body,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/plain" : null,
    },
  } as unknown as Response;
}

interface FakeConnection {
  readonly simulateTransaction: ReturnType<typeof vi.fn>;
  readonly sendTransaction: ReturnType<typeof vi.fn>;
  readonly sendRawTransaction: ReturnType<typeof vi.fn>;
  readonly confirmTransaction: ReturnType<typeof vi.fn>;
  readonly getLatestBlockhash: ReturnType<typeof vi.fn>;
  readonly getParsedAccountInfo: ReturnType<typeof vi.fn>;
}

function createFakeConnection(): FakeConnection {
  return {
    simulateTransaction: vi.fn(async () => ({
      context: { slot: 1 },
      value: {
        err: null,
        logs: ["Program log: ok"],
        unitsConsumed: 1_234,
        accounts: null,
        returnData: null,
      },
    })),
    sendTransaction: vi.fn(async () => {
      throw new Error("sendTransaction must not be called during simulation");
    }),
    sendRawTransaction: vi.fn(async () => {
      throw new Error(
        "sendRawTransaction must not be called during simulation",
      );
    }),
    confirmTransaction: vi.fn(async () => {
      throw new Error(
        "confirmTransaction must not be called during simulation",
      );
    }),
    getLatestBlockhash: vi.fn(async () => {
      throw new Error(
        "getLatestBlockhash must not be called during simulation",
      );
    }),
    getParsedAccountInfo: vi.fn(async () => {
      throw new Error(
        "getParsedAccountInfo is only expected for non-SOL input mints; override it in the test that needs it",
      );
    }),
  };
}

function createRuntime(
  fakeConnection: FakeConnection,
  settings: Record<string, string> = {},
): IAgentRuntime {
  const fakeSolanaService = { getConnection: () => fakeConnection };
  return {
    agentId: "test-agent",
    character: { name: "Test Agent", settings: {} },
    getService: vi.fn((name: string) =>
      name === SOLANA_SERVICE_NAME ? fakeSolanaService : null,
    ),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    setSetting: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function createContext(runtime: IAgentRuntime): WalletRouterContext {
  return {
    runtime,
    walletBackend: null,
    walletServices: [],
    tokenDataService: null,
  };
}

function swapParams(
  overrides: Partial<WalletRouterParams> = {},
): WalletRouterParams {
  return {
    subaction: "swap",
    chain: "solana",
    fromToken: "SOL",
    toToken: Keypair.generate().publicKey.toBase58(),
    amount: "1",
    mode: "simulate",
    dryRun: false,
    ...overrides,
  };
}

function pumpFunParams(
  mint: string,
  overrides: Partial<WalletRouterParams> = {},
): WalletRouterParams {
  return {
    subaction: "pump_fun_buy",
    toToken: mint,
    amount: "0.01",
    mode: "simulate",
    dryRun: false,
    ...overrides,
  };
}

describe("Solana simulate mode (GH #16613)", () => {
  const walletPublicKey = Keypair.generate().publicKey;

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("simulateSolanaSwap returns a typed mapping of the quote and simulation result without broadcasting", async () => {
    const fakeTx = buildFakeVersionedTransaction();
    const swapTxBase64 = Buffer.from(fakeTx.serialize()).toString("base64");
    const outputMint = Keypair.generate().publicKey.toBase58();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://quote-api.jup.ag/v6/quote")) {
        return jsonResponse({
          inputMint: "So11111111111111111111111111111111111111112",
          inAmount: "1000000000",
          outputMint,
          outAmount: "150000000",
          priceImpactPct: "0.0012",
          slippageBps: 50,
          routePlan: [
            {
              swapInfo: {
                label: "Orca",
                inputMint: "So11111111111111111111111111111111111111112",
                outputMint,
              },
              percent: 100,
            },
          ],
        });
      }
      if (url === "https://quote-api.jup.ag/v6/swap") {
        return jsonResponse({ swapTransaction: swapTxBase64 });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });

    const result = await simulateSolanaSwap(
      swapParams({ toToken: outputMint }),
      createContext(runtime),
    );

    expect(result.status).toBe("simulated");
    expect(result.simulation?.success).toBe(true);
    expect(result.simulation?.err).toBeNull();
    expect(result.simulation?.unitsConsumed).toBe(1_234);
    expect(result.simulation?.logs).toEqual(["Program log: ok"]);
    expect(result.simulation?.summary).toMatchObject({
      inToken: "So11111111111111111111111111111111111111112",
      outToken: outputMint,
      inAmount: "1000000000",
      outAmount: "150000000",
      priceImpactPct: "0.0012",
    });
    // Typed route/slippage (review on #19243): consumers must be able to
    // evaluate the actual route and slippage, not only amounts.
    expect(result.simulation?.route).toEqual([
      {
        label: "Orca",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint,
        percent: 100,
      },
    ]);
    expect(result.simulation?.requestedSlippageBps).toBeNull();
    expect(result.simulation?.effectiveSlippageBps).toBe(50);

    expect(fakeConnection.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(fakeConnection.simulateTransaction).toHaveBeenCalledWith(
      expect.any(VersionedTransaction),
      { sigVerify: false, replaceRecentBlockhash: true },
    );
    expect(fakeConnection.sendTransaction).not.toHaveBeenCalled();
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
    expect(fakeConnection.confirmTransaction).not.toHaveBeenCalled();
  });

  it("simulatePumpFunBuy returns a typed mapping of the trade-local build and simulation result without broadcasting", async () => {
    const fakeTx = buildFakeVersionedTransaction();
    const mint = Keypair.generate().publicKey.toBase58();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === PUMPFUN_TRADE_LOCAL_URL) {
        return binaryResponse(fakeTx.serialize());
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });

    const result = await simulatePumpFunBuy(
      pumpFunParams(mint),
      createContext(runtime),
    );

    expect(result.status).toBe("simulated");
    expect(result.chain).toBe("pumpfun");
    expect(result.simulation?.success).toBe(true);
    expect(result.simulation?.unitsConsumed).toBe(1_234);
    expect(result.simulation?.summary).toEqual({
      mint,
      solAmount: 0.01,
    });

    expect(fakeConnection.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(fakeConnection.sendTransaction).not.toHaveBeenCalled();
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
    expect(fakeConnection.confirmTransaction).not.toHaveBeenCalled();
  });

  it("never signs the transaction while simulating (swap or pump.fun)", async () => {
    const fakeTx = buildFakeVersionedTransaction();
    const swapTxBase64 = Buffer.from(fakeTx.serialize()).toString("base64");
    const mint = Keypair.generate().publicKey.toBase58();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://quote-api.jup.ag/v6/quote")) {
        return jsonResponse({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          inAmount: "1000000000",
          outAmount: "1",
          priceImpactPct: "0",
        });
      }
      if (url === "https://quote-api.jup.ag/v6/swap") {
        return jsonResponse({ swapTransaction: swapTxBase64 });
      }
      if (url === PUMPFUN_TRADE_LOCAL_URL) {
        return binaryResponse(fakeTx.serialize());
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const signSpy = vi
      .spyOn(VersionedTransaction.prototype, "sign")
      .mockImplementation(() => {
        throw new Error("sign must not be called during simulation");
      });

    const fakeConnection = createFakeConnection();
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });
    const context = createContext(runtime);

    await expect(
      simulateSolanaSwap(swapParams({ toToken: mint }), context),
    ).resolves.toMatchObject({ status: "simulated" });
    await expect(
      simulatePumpFunBuy(pumpFunParams(mint), context),
    ).resolves.toMatchObject({ status: "simulated" });

    expect(signSpy).not.toHaveBeenCalled();
  });

  it("maps an RPC-reported simulation revert to a typed success:false result, not a throw", async () => {
    const fakeTx = buildFakeVersionedTransaction();
    const swapTxBase64 = Buffer.from(fakeTx.serialize()).toString("base64");
    const mint = Keypair.generate().publicKey.toBase58();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://quote-api.jup.ag/v6/quote")) {
        return jsonResponse({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          inAmount: "1000000000",
          outAmount: "1",
          priceImpactPct: "0",
        });
      }
      if (url === "https://quote-api.jup.ag/v6/swap") {
        return jsonResponse({ swapTransaction: swapTxBase64 });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    fakeConnection.simulateTransaction.mockResolvedValueOnce({
      context: { slot: 1 },
      value: {
        err: { InstructionError: [0, { Custom: 6001 }] },
        logs: ["Program log: failed", "Program log: insufficient funds"],
        unitsConsumed: 5_000,
        accounts: null,
        returnData: null,
      },
    });
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });

    const result = await simulateSolanaSwap(
      swapParams({ toToken: mint }),
      createContext(runtime),
    );

    expect(result.status).toBe("simulated");
    expect(result.simulation?.success).toBe(false);
    expect(result.simulation?.err).toContain("InstructionError");
    expect(result.simulation?.logs).toEqual([
      "Program log: failed",
      "Program log: insufficient funds",
    ]);
    expect(result.simulation?.unitsConsumed).toBe(5_000);
    expect(fakeConnection.sendTransaction).not.toHaveBeenCalled();
  });

  it("throws a typed error when the Jupiter quote fails (transport/build failure, not a fabricated simulation)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://quote-api.jup.ag/v6/quote")) {
        return jsonResponse({ error: "no route found" });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });

    await expect(
      simulateSolanaSwap(swapParams(), createContext(runtime)),
    ).rejects.toThrow(/Failed to get Jupiter quote: no route found/);
    expect(fakeConnection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("throws a typed error when PumpPortal trade-local fails (transport/build failure, not a fabricated simulation)", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === PUMPFUN_TRADE_LOCAL_URL) {
        return errorResponse(500, "pool not found");
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });

    await expect(
      simulatePumpFunBuy(pumpFunParams(mint), createContext(runtime)),
    ).rejects.toThrow(/PumpPortal trade-local failed \(500\)/);
    expect(fakeConnection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("resolves decimals for a non-SOL input mint via getParsedAccountInfo without broadcasting (#19243 review)", async () => {
    const fakeTx = buildFakeVersionedTransaction();
    const swapTxBase64 = Buffer.from(fakeTx.serialize()).toString("base64");
    const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const outputMint = Keypair.generate().publicKey.toBase58();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://quote-api.jup.ag/v6/quote")) {
        return jsonResponse({
          inputMint,
          inAmount: "1000000",
          outputMint,
          outAmount: "990000",
          priceImpactPct: "0.0001",
          slippageBps: 50,
          routePlan: [],
        });
      }
      if (url === "https://quote-api.jup.ag/v6/swap") {
        return jsonResponse({ swapTransaction: swapTxBase64 });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    fakeConnection.getParsedAccountInfo.mockResolvedValue({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    });
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });

    const result = await simulateSolanaSwap(
      swapParams({ fromToken: inputMint, toToken: outputMint }),
      createContext(runtime),
    );

    expect(result.status).toBe("simulated");
    expect(fakeConnection.getParsedAccountInfo).toHaveBeenCalledTimes(1);
    expect(fakeConnection.sendTransaction).not.toHaveBeenCalled();
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
    expect(fakeConnection.confirmTransaction).not.toHaveBeenCalled();
  });

  it("reports requested/effective slippage for pump.fun simulation (#19243 review)", async () => {
    const fakeTx = buildFakeVersionedTransaction();
    const mint = Keypair.generate().publicKey.toBase58();

    const fetchMock = vi.fn(async () => binaryResponse(fakeTx.serialize()));
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    const runtime = createRuntime(fakeConnection, {
      SOLANA_PUBLIC_KEY: walletPublicKey.toBase58(),
    });

    const result = await simulatePumpFunBuy(
      pumpFunParams(mint, { slippageBps: 100 }),
      createContext(runtime),
    );

    expect(result.simulation?.route).toEqual([]);
    expect(result.simulation?.requestedSlippageBps).toBe(100);
    expect(result.simulation?.effectiveSlippageBps).toBe(100);
  });

  it("never creates or persists a wallet key when simulating without one configured (#19243 review, P2)", async () => {
    const fakeTx = buildFakeVersionedTransaction();
    const swapTxBase64 = Buffer.from(fakeTx.serialize()).toString("base64");
    const mint = Keypair.generate().publicKey.toBase58();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://quote-api.jup.ag/v6/quote")) {
        return jsonResponse({ inAmount: "1", outAmount: "1", routePlan: [] });
      }
      if (url === "https://quote-api.jup.ag/v6/swap") {
        return jsonResponse({ swapTransaction: swapTxBase64 });
      }
      return binaryResponse(fakeTx.serialize());
    });
    vi.stubGlobal("fetch", fetchMock);

    const fakeConnection = createFakeConnection();
    // No SOLANA_PUBLIC_KEY / SOLANA_PRIVATE_KEY settings at all.
    const runtime = createRuntime(fakeConnection, {});

    await expect(
      simulatePumpFunBuy(pumpFunParams(mint), createContext(runtime)),
    ).rejects.toThrow(/no.*key|not configured/i);
    await expect(
      simulateSolanaSwap(swapParams(), createContext(runtime)),
    ).rejects.toThrow(/no.*key|not configured/i);

    // The read-only simulation must never mint a secret as a side effect.
    expect(
      (runtime as unknown as { setSetting: ReturnType<typeof vi.fn> })
        .setSetting,
    ).not.toHaveBeenCalled();
    expect(fakeConnection.simulateTransaction).not.toHaveBeenCalled();
  });

  it("SolanaService fails closed for mode=simulate on every direct entry (#19243 review, P1)", async () => {
    const runtime = createRuntime(createFakeConnection(), {
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    }) as unknown as IAgentRuntime & {
      getServiceLoadPromise: () => Promise<unknown>;
    };
    (
      runtime as unknown as { getServiceLoadPromise: unknown }
    ).getServiceLoadPromise = () => new Promise(() => {});

    const service = new SolanaService(runtime);

    await expect(
      service.transfer({
        recipient: Keypair.generate().publicKey.toBase58(),
        amount: "1",
        mode: "simulate",
        dryRun: false,
      }),
    ).rejects.toThrow(/simulate/);
    await expect(
      service.swap({
        inputTokenCA: "So11111111111111111111111111111111111111112",
        outputTokenCA: Keypair.generate().publicKey.toBase58(),
        amount: 1,
        mode: "simulate",
        dryRun: false,
      }),
    ).rejects.toThrow(/simulate/);
    await expect(
      service.executeWalletRouterAction(swapParams({ chain: "solana" })),
    ).rejects.toThrow(/simulate/);
  });
});
