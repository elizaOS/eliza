import type { IAgentRuntime } from "@elizaos/core";
import {
  Keypair,
  SystemProgram,
  type VersionedTransaction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletBackendService } from "../services/wallet-backend-service.js";
import type {
  WalletChainHandler,
  WalletRouterContext,
} from "../types/wallet-router.js";

vi.mock(
  "@elizaos/core",
  async () => import("../__tests__/core-vitest-mock.js"),
);
vi.mock("./solana/keypairUtils", () => ({
  getWalletKey: vi.fn(),
  getExistingSolanaPublicKey: vi.fn(),
}));
// EVM handlers are unrelated to this registered Solana path. Keep their
// provider/bridge graphs out of this test's controlled signer and RPC boundary.
vi.mock("./evm/actions/helpers", () => ({ buildSendTxParams: vi.fn() }));
vi.mock("./evm/actions/swap", () => ({ SwapAction: vi.fn() }));
vi.mock("./evm/actions/transfer", () => ({ TransferAction: vi.fn() }));
vi.mock("./evm/bridge-router", () => ({ routeEvmBridge: vi.fn() }));
vi.mock("./evm/providers/wallet", () => ({ initWalletProvider: vi.fn() }));

import { registerDefaultWalletChainHandlers } from "./registry.js";
import { SOLANA_SERVICE_NAME } from "./solana/constants.js";
import { getWalletKey } from "./solana/keypairUtils.js";

describe("registered native SOL transfer amount", () => {
  const sender = Keypair.fromSeed(new Uint8Array(32).fill(1));
  const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
  const connection = {
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: recipient.toBase58(),
      lastValidBlockHeight: 1,
    })),
    sendTransaction: vi.fn(
      async (_transaction: VersionedTransaction) => "synthetic-signature",
    ),
  };
  let handler: WalletChainHandler;
  let context: WalletRouterContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Network access is forbidden in transfer tests");
      }),
    );
    vi.mocked(getWalletKey).mockResolvedValue({ keypair: sender });
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
    if (!solana) throw new Error("Solana handler was not registered");
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

  const params = (amount: string | undefined) => ({
    subaction: "transfer" as const,
    fromToken: "SOL",
    recipient: recipient.toBase58(),
    amount,
    mode: "execute" as const,
    dryRun: false,
  });

  it.each<[string, number]>([
    ["0.1", 100_000_000],
    ["0.000000001", 1],
    ["1e-9", 1],
    ["1.234567891", 1_234_567_891],
    ["1.2300000000", 1_230_000_000],
    ["9007199.254740991", Number.MAX_SAFE_INTEGER],
  ])(
    "passes exact safe integer lamports for %s to the real SDK",
    async (amount, expected) => {
      const transfer = vi.spyOn(SystemProgram, "transfer");
      const result = await handler.execute(params(amount), context);
      expect(transfer).toHaveBeenCalledExactlyOnceWith({
        fromPubkey: sender.publicKey,
        toPubkey: recipient,
        lamports: expected,
      });
      expect(connection.sendTransaction).toHaveBeenCalledOnce();
      const transaction = connection.sendTransaction.mock.calls[0][0];
      // Inspect the actual serialized SystemProgram instruction, not just the
      // function argument: a decimal parse must survive SDK encoding unchanged.
      const instruction = transaction.message.compiledInstructions[0];
      expect(Buffer.from(instruction.data).readBigUInt64LE(4)).toBe(
        BigInt(expected),
      );
      expect(transaction.signatures[0].some((byte) => byte !== 0)).toBe(true);
      expect(result).toMatchObject({
        status: "submitted",
        signature: "synthetic-signature",
        amount,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "",
    "not-a-number",
    "NaN",
    "Infinity",
    "-Infinity",
    "0",
    "-1",
    "0.0000000001",
    "0.0000000009",
    "1.0000000001",
    "9007199.254740992",
    "1e1000",
  ])(
    "rejects %s before resolving a signer or making any RPC call",
    async (amount) => {
      const transfer = vi.spyOn(SystemProgram, "transfer");
      await expect(
        handler.execute(params(amount), context),
      ).rejects.toMatchObject({ code: "SOLANA_TRANSFER_AMOUNT_INVALID" });
      expect(getWalletKey).not.toHaveBeenCalled();
      expect(context.runtime.getService).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
      expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
      expect(connection.sendTransaction).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("registered SPL token transfer amount", () => {
  const sender = Keypair.fromSeed(new Uint8Array(32).fill(1));
  const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
  const connection = {
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: recipient.toBase58(),
      lastValidBlockHeight: 1,
    })),
    sendTransaction: vi.fn(
      async (_transaction: VersionedTransaction) => "synthetic-signature",
    ),
    getParsedAccountInfo: vi.fn(async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    })),
    getAccountInfo: vi.fn(async () => ({ lamports: 1 })),
  };
  let handler: WalletChainHandler;
  let context: WalletRouterContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Network access is forbidden in transfer tests");
      }),
    );
    vi.mocked(getWalletKey).mockResolvedValue({ keypair: sender });
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
    if (!solana) throw new Error("Solana handler was not registered");
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

  const params = (amount: string | undefined) => ({
    subaction: "transfer" as const,
    fromToken: mint.toBase58(),
    recipient: recipient.toBase58(),
    amount,
    mode: "execute" as const,
    dryRun: false,
  });

  it.each<[string, bigint]>([
    ["1.25", 1_250_000n],
    ["0.000001", 1n],
    ["2", 2_000_000n],
  ])(
    "passes exact 6-decimal base units for %s to the real SDK",
    async (amount, expected) => {
      const result = await handler.execute(params(amount), context);
      expect(connection.sendTransaction).toHaveBeenCalledOnce();
      const transaction = connection.sendTransaction.mock.calls[0]?.[0];
      const instruction = transaction?.message.compiledInstructions.at(-1);
      expect(instruction).toBeDefined();
      expect(Buffer.from(instruction?.data ?? []).readBigUInt64LE(1)).toBe(
        expected,
      );
      expect(result).toMatchObject({
        status: "submitted",
        signature: "synthetic-signature",
        amount,
        fromToken: mint.toBase58(),
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "1.0000005",
    "0.0000004",
    "0.0000005",
    "0",
    "-1",
    "not-a-number",
    "",
    "18446744073709.551616",
  ])(
    "rejects %s before resolving a signer or submitting a transfer",
    async (amount) => {
      await expect(
        handler.execute(params(amount), context),
      ).rejects.toMatchObject({
        code: "SOLANA_TOKEN_TRANSFER_AMOUNT_INVALID",
      });
      expect(getWalletKey).not.toHaveBeenCalled();
      expect(connection.getAccountInfo).not.toHaveBeenCalled();
      expect(connection.sendTransaction).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
