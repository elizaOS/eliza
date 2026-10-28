/**
 * Regression tests for Solana transfer confirmation states.
 *
 * `executeSolanaTransfer` must distinguish three outcomes:
 * 1. Confirmed on-chain -> status "submitted", metadata.confirmationStatus "confirmed"
 * 2. Explicit on-chain failure -> throws (safe to retry)
 * 3. Uncertain (e.g. RPC timeout) -> status "submitted",
 *    metadata.confirmationStatus "unconfirmed", signature preserved.
 *    Must NOT be reported as success, must NOT trigger auto-retry.
 *
 * No live network, no real funds. The Solana Connection is mocked;
 * the transfer logic under test is the real production path.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @solana/web3.js before importing registry
// Use vi.hoisted because vi.mock is hoisted to the top
const {
  mockConfirmTransaction,
  mockSendTransaction,
  mockGetLatestBlockhash,
  mockGetAccountInfo,
  mockGetParsedAccountInfo,
} = vi.hoisted(() => ({
  mockConfirmTransaction: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockGetLatestBlockhash: vi.fn(),
  mockGetAccountInfo: vi.fn(),
  mockGetParsedAccountInfo: vi.fn(),
}));

const { testKeypairHolder } = vi.hoisted(() => ({
  testKeypairHolder: { keypair: null as unknown },
}));

vi.mock("@solana/web3.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@solana/web3.js")>();
  // Generate a real test keypair for the mock (not a real wallet)
  testKeypairHolder.keypair = original.Keypair.generate();
  return {
    ...original,
    Connection: vi.fn().mockImplementation(() => ({
      sendTransaction: mockSendTransaction,
      confirmTransaction: mockConfirmTransaction,
      getLatestBlockhash: mockGetLatestBlockhash,
      getAccountInfo: mockGetAccountInfo,
      getParsedAccountInfo: mockGetParsedAccountInfo,
    })),
  };
});

vi.mock("../solana/keypairUtils", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../solana/keypairUtils")>();
  return {
    ...original,
    getWalletKey: vi.fn().mockImplementation(async () => ({
      keypair: testKeypairHolder.keypair,
    })),
  };
});

import { WalletBackendService } from "../../services/wallet-backend-service";
import { registerDefaultWalletChainHandlers } from "../registry";

function createMockRuntime(): IAgentRuntime {
  const mockConnection = {
    sendTransaction: mockSendTransaction,
    confirmTransaction: mockConfirmTransaction,
    getLatestBlockhash: mockGetLatestBlockhash,
    getAccountInfo: mockGetAccountInfo,
    getParsedAccountInfo: mockGetParsedAccountInfo,
  };
  const mockSolanaService = {
    getConnection: () => mockConnection,
  };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
  const cache = new Map<string, unknown>();
  return {
    agentId: "test-agent",
    character: { name: "Test Agent", settings: {} },
    getService: vi.fn((name: string) => {
      if (name === "chain_solana") return mockSolanaService;
      return null;
    }),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    setSetting: vi.fn(async () => true),
    getCache: vi.fn(async <T>(key: string) => cache.get(key) as T | undefined),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => {
      cache.delete(key);
      return true;
    }),
    logger,
  } as unknown as IAgentRuntime;
}

function createTransferParams() {
  return {
    subaction: "transfer" as const,
    chain: "solana",
    recipient: "11111111111111111111111111111111",
    amount: "0.001",
    fromToken: "SOL",
    mode: "execute" as const,
    dryRun: false,
  };
}

describe("Solana transfer confirmation states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestBlockhash.mockResolvedValue({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 123456,
    });
    mockGetAccountInfo.mockResolvedValue(null);
    mockSendTransaction.mockResolvedValue("test-signature-abc123");
    // Default: USDC has 6 decimals
    mockGetParsedAccountInfo.mockResolvedValue({
      value: {
        data: {
          parsed: {
            info: {
              decimals: 6,
            },
          },
        },
      },
    });
  });

  it("SOL transfer: confirmed on-chain -> status submitted, confirmationStatus confirmed", async () => {
    mockConfirmTransaction.mockResolvedValue({ value: { err: null } });

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe("submitted");
      expect(result.result.signature).toBe("test-signature-abc123");
      expect(
        (result.result.metadata as { confirmationStatus?: string })
          ?.confirmationStatus,
      ).toBe("confirmed");
    }
  });

  it("SOL transfer: explicit on-chain failure -> ok:false with failure detail", async () => {
    mockConfirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [0, "InsufficientFunds"] } },
    });

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
    });

    // Explicit failure must be reported as failure (safe to retry),
    // NOT as unconfirmed
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EXECUTION_FAILED");
      expect(result.detail).toContain("Solana transfer failed on-chain");
    }
  });

  it("SOL transfer: RPC timeout -> status submitted, confirmationStatus unconfirmed, signature preserved", async () => {
    // confirmTransaction throws (timeout) - outcome uncertain
    mockConfirmTransaction.mockRejectedValue(new Error("RPC timeout"));

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
    });

    // Must NOT throw (would trigger retry -> duplicate risk)
    // Must NOT report as confirmed success
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe("submitted");
      // Signature preserved for manual explorer verification
      expect(result.result.signature).toBe("test-signature-abc123");
      expect(
        (result.result.metadata as { confirmationStatus?: string })
          ?.confirmationStatus,
      ).toBe("unconfirmed");
    }
  });

  it("SPL transfer: confirmed on-chain -> status submitted", async () => {
    mockConfirmTransaction.mockResolvedValue({ value: { err: null } });
    // SPL path needs token decimals and ATA. A mint account is owned by a
    // token program; the transfer reads that owner to pick the program.
    const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
    mockGetAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: TOKEN_PROGRAM_ID,
    });

    // Generate a test mint at runtime (not a real token, no secrets).
    // A hardcoded mint address triggers secret scanners (false positive).
    const { Keypair } = await import("@solana/web3.js");
    const testMint = Keypair.generate().publicKey.toBase58();

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
      fromToken: testMint,
      amount: "1.5",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe("submitted");
      expect(
        (result.result.metadata as { confirmationStatus?: string })
          ?.confirmationStatus,
      ).toBe("confirmed");
    }
  });

  it("Pre-send failure (e.g. invalid recipient) -> ok:false before broadcast", async () => {
    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
      recipient: "", // Invalid - should fail before sendTransaction
    });

    expect(result.ok).toBe(false);
    // sendTransaction must NOT have been called
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("SOL transfer: sendTransaction network error -> unconfirmed with derived signature, no throw", async () => {
    // sendTransaction throws a non-SendTransactionError (e.g. network timeout
    // after broadcast). The broadcast status is uncertain: do NOT throw
    // (would invite retry -> duplicate risk). Return unconfirmed instead.
    mockSendTransaction.mockRejectedValue(
      new Error("fetch failed: network timeout"),
    );

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe("submitted");
      // Signature derived from the signed transaction (not from RPC)
      expect(result.result.signature).toBeTruthy();
      expect(typeof result.result.signature).toBe("string");
      const metadata = result.result.metadata as {
        confirmationStatus?: string;
        sendUncertain?: boolean;
      };
      expect(metadata?.confirmationStatus).toBe("unconfirmed");
      expect(metadata?.sendUncertain).toBe(true);
      // confirmTransaction must NOT have been called (no signature from RPC)
      expect(mockConfirmTransaction).not.toHaveBeenCalled();
    }
  });

  it("SOL transfer: sendTransaction simulation failure -> ok:false (RPC rejected)", async () => {
    // SendTransactionError means the RPC answered with an error (the node
    // processed the request). With skipPreflight: false this includes
    // preflight/simulation rejections where the node does NOT broadcast.
    // Definitive failure: must be reported as failure, not as "submitted".
    const { SendTransactionError } = await import("@solana/web3.js");
    mockSendTransaction.mockRejectedValue(
      new SendTransactionError({
        action: "simulate",
        signature: "",
        transactionMessage:
          "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
        logs: [],
      }),
    );

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
    });

    // Definitive failure: ok must be false, with the RPC reason preserved.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EXECUTION_FAILED");
      expect(result.detail).toContain("Transaction simulation failed");
    }
    // confirmTransaction must NOT have been called (no signature from RPC).
    expect(mockConfirmTransaction).not.toHaveBeenCalled();
  });

  it("SOL transfer: RPC node unhealthy -> unconfirmed (not definitive)", async () => {
    // Node unhealthy errors are RPC failures, not proof of non-broadcast.
    mockSendTransaction.mockRejectedValue(
      new Error("failed to get confirmed block: node is unhealthy"),
    );

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const metadata = result.result.metadata as {
        confirmationStatus?: string;
        sendUncertain?: boolean;
      };
      expect(metadata?.confirmationStatus).toBe("unconfirmed");
      expect(metadata?.sendUncertain).toBe(true);
    }
  });

  it("SOL transfer: empty RPC response (response loss) -> unconfirmed", async () => {
    // Response loss: the RPC may have processed the tx but the response
    // was lost. Broadcast status is uncertain.
    mockSendTransaction.mockRejectedValue(
      new Error("Unexpected end of JSON input"),
    );

    const runtime = createMockRuntime();
    const service = new WalletBackendService(runtime);
    registerDefaultWalletChainHandlers(service, runtime);

    const result = await service.routeWalletAction({
      ...createTransferParams(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const metadata = result.result.metadata as {
        confirmationStatus?: string;
        sendUncertain?: boolean;
      };
      expect(metadata?.confirmationStatus).toBe("unconfirmed");
      expect(metadata?.sendUncertain).toBe(true);
      // Signature must be derived (not from RPC)
      expect(result.result.signature).toBeTruthy();
    }
  });
});
