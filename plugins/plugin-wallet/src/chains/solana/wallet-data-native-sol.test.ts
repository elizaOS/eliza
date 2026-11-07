/**
 * Without a Birdeye key the wallet data comes from the RPC fallback. Token
 * accounts list SPL tokens only, so native SOL must be read from the
 * account's own lamports, or a SOL-only wallet is reported as empty. Real
 * SolanaService methods; only the RPC connection and runtime cache are stubbed.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SolanaService } from "./service";

const OWNER = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const SOL_MINT = "So11111111111111111111111111111111111111112";

function service(lamports: number) {
  const cache = new Map<string, unknown>();
  const svc = Object.create(SolanaService.prototype) as SolanaService & Record<string, unknown>;
  Object.assign(svc, {
    runtime: {
      getSetting: () => undefined,
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      },
      logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      character: { name: "agent" },
    },
    lastUpdate: 0,
    UPDATE_INTERVAL: 120_000,
    decimalsCache: new Map(),
    ensurePublicKey: async () => OWNER,
    connection: {
      getParsedTokenAccountsByOwner: async () => ({ context: { slot: 1 }, value: [] }),
      getBalance: async () => lamports,
    },
  });
  return svc;
}

describe("Solana wallet data without Birdeye", () => {
  it("reports the native SOL balance of a SOL-only wallet", async () => {
    const data = await service(5_000_000_000).updateWalletData(true);
    expect(data.totalSol).toBe("5");
    expect(data.items).toEqual([
      expect.objectContaining({
        symbol: "SOL",
        address: SOL_MINT,
        decimals: 9,
        balance: "5000000000",
        uiAmount: "5",
      }),
    ]);
  });

  it("reports an empty wallet as empty", async () => {
    const data = await service(0).updateWalletData(true);
    expect(data).toMatchObject({ totalSol: "0", items: [] });
  });
});
