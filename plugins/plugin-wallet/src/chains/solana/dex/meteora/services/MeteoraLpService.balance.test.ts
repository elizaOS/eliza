import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
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
