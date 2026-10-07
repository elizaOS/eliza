import type { IAgentRuntime } from "@elizaos/core";
import { Keypair, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaService } from "./service";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function makeService(): SolanaService {
  const runtime = {
    fetch: vi.fn(async () => {
      throw new Error("Network access is forbidden in transfer amount tests");
    }),
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
  return new SolanaService(runtime);
}

describe("SolanaService transfer amount", () => {
  const sender = Keypair.fromSeed(new Uint8Array(32).fill(8));
  const recipient = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes exact lamports for 0.1 SOL before broadcast", async () => {
    const service = makeService();
    vi.spyOn(service, "getWalletKeypair").mockResolvedValue(sender);
    const transfer = vi.spyOn(SystemProgram, "transfer");
    const result = await service.transfer({
      recipient: recipient.toBase58(),
      amount: "0.1",
      mode: "prepare",
      dryRun: true,
    });
    expect(transfer).toHaveBeenCalledExactlyOnceWith({
      fromPubkey: sender.publicKey,
      toPubkey: recipient,
      lamports: 100_000_000n,
    });
    expect(result).toMatchObject({ success: true, dryRun: true, kind: "sol" });
  });

  it("passes exact 6-decimal base units for 1.25 USDC", async () => {
    const service = makeService();
    vi.spyOn(service, "getWalletKeypair").mockResolvedValue(sender);
    const connection = (
      service as unknown as {
        connection: {
          getAccountInfo: (...args: unknown[]) => Promise<unknown>;
          getLatestBlockhash: (...args: unknown[]) => Promise<unknown>;
          sendTransaction: (...args: unknown[]) => Promise<unknown>;
        };
      }
    ).connection;
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue({ lamports: 1 });
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: recipient.toBase58(),
      lastValidBlockHeight: 1,
    });
    vi.spyOn(connection, "sendTransaction").mockResolvedValue("synthetic-signature");
    const result = await service.transfer({
      recipient: recipient.toBase58(),
      tokenAddress: USDC,
      amount: "1.25",
      mode: "execute",
      dryRun: false,
    });
    const transaction = connection.sendTransaction.mock.calls[0]?.[0] as
      | VersionedTransaction
      | undefined;
    const instruction = transaction?.message.compiledInstructions.at(-1);
    expect(Buffer.from(instruction?.data ?? []).readBigUInt64LE(1)).toBe(1_250_000n);
    expect(result).toMatchObject({
      success: true,
      dryRun: false,
      kind: "spl",
      signature: "synthetic-signature",
    });
  });

  it.each([
    ["1.0000000004", undefined],
    ["1.0000005", USDC],
    ["0.0000005", USDC],
  ])("rejects %s before resolving a signer", async (amount, tokenAddress) => {
    const service = makeService();
    const keypair = vi.spyOn(service, "getWalletKeypair").mockResolvedValue(sender);
    const solTransfer = vi.spyOn(SystemProgram, "transfer");
    await expect(
      service.transfer({
        recipient: recipient.toBase58(),
        ...(tokenAddress ? { tokenAddress } : {}),
        amount,
        mode: "prepare",
        dryRun: true,
      })
    ).rejects.toMatchObject({
      code: "SOLANA_SERVICE_TRANSFER_AMOUNT_INVALID",
    });
    expect(keypair).not.toHaveBeenCalled();
    expect(solTransfer).not.toHaveBeenCalled();
  });
});
