import { Keypair, SystemProgram, Transaction, type VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DLMM } from "../utils/dlmm.ts";
import { MeteoraLpService } from "./MeteoraLpService.ts";

describe("MeteoraLpService.getTokenBalance", () => {
  it("propagates an RPC failure instead of reporting zero", async () => {
    const service = new MeteoraLpService();
    const connection = {
      getParsedTokenAccountsByOwner: async () => {
        throw new Error("rpc down");
      },
    };
    (service as unknown as { connection: typeof connection }).connection = connection;
    const read = (
      service as unknown as {
        getTokenBalance: (wallet: unknown, mint: unknown) => Promise<bigint>;
      }
    ).getTokenBalance.bind(service);

    await expect(read(Keypair.generate().publicKey, Keypair.generate().publicKey)).rejects.toThrow(
      "rpc down"
    );
  });

  it("reports zero when the mint has no token accounts", async () => {
    const service = new MeteoraLpService();
    const connection = {
      getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    };
    (service as unknown as { connection: typeof connection }).connection = connection;
    const read = (
      service as unknown as {
        getTokenBalance: (wallet: unknown, mint: unknown) => Promise<bigint>;
      }
    ).getTokenBalance.bind(service);

    await expect(read(Keypair.generate().publicKey, Keypair.generate().publicKey)).resolves.toBe(
      0n
    );
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Meteora withdrawal balance boundaries", () => {
  it.each(["pre", "post"] as const)("keeps a malformed %s-read honest", async (phase) => {
    const payer = Keypair.generate();
    const pool = Keypair.generate().publicKey;
    const mintA = Keypair.generate().publicKey;
    const mintB = Keypair.generate().publicKey;
    const reportError = vi.fn();
    const service = new MeteoraLpService({ getSetting: () => undefined, reportError } as never);
    const sent: VersionedTransaction[] = [];
    let reads = 0;
    const connection = {
      getParsedTokenAccountsByOwner: async () => {
        reads += 1;
        return {
          value: [
            {
              account: {
                data: {
                  parsed: {
                    info:
                      reads === (phase === "pre" ? 1 : 3)
                        ? {}
                        : { tokenAmount: { amount: "1000" } },
                  },
                },
              },
            },
          ],
        };
      },
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
      simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 100_000 } }),
      getRecentPrioritizationFees: async () => [],
      sendTransaction: async (tx: VersionedTransaction) => {
        sent.push(tx);
        return "confirmed-signature";
      },
      getSignatureStatuses: async () => ({ value: [{ err: null }] }),
      confirmTransaction: async () => ({ value: { err: null } }),
    };
    (service as unknown as { connection: typeof connection }).connection = connection;
    vi.spyOn(service, "getPools").mockResolvedValue([
      {
        id: pool.toBase58(),
        tokenA: { mint: mintA.toBase58(), symbol: "A", decimals: 6 },
        tokenB: { mint: mintB.toBase58(), symbol: "B", decimals: 6 },
      },
    ] as never);
    vi.spyOn(DLMM, "create").mockResolvedValue({
      getPositionsByUserAndLbPair: async () => ({
        userPositions: [
          {
            publicKey: Keypair.generate().publicKey,
            positionData: { positionBinData: [{ binId: 1 }] },
          },
        ],
      }),
      removeLiquidity: async () =>
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: pool,
            lamports: 0,
          })
        ),
    } as never);
    const result = await service.removeLiquidity({
      userVault: payer,
      poolId: pool.toBase58(),
      lpTokenAmountLamports: "1",
      slippageBps: 100,
    });
    expect(result).not.toHaveProperty("tokensReceived");
    expect(reportError).toHaveBeenCalledWith(
      phase === "pre" ? "meteora.withdrawal" : "meteora.withdrawal.balance",
      expect.objectContaining({ code: "METEORA_TOKEN_ACCOUNT_INVALID" }),
      expect.any(Object)
    );
    if (phase === "pre") {
      expect(result.success).toBe(false);
      expect(sent).toHaveLength(0);
    } else {
      expect(result).toMatchObject({ success: true, transactionId: "confirmed-signature" });
      expect(sent).toHaveLength(1);
      expect(sent[0].signatures[0].some((byte) => byte !== 0)).toBe(true);
    }
  });
});
