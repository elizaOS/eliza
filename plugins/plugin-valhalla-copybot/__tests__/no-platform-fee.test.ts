import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { executeLiveSwap } from "../src/live-swap.ts";

describe("Jupiter requests", () => {
  it("does not send platformFeeBps or a fee account", async () => {
    const key = Keypair.generate();
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push(`${url}\n${init?.body ? String(init.body) : ""}`);
      if (calls.length === 1) return new Response(JSON.stringify({ outAmount: "1" }), { status: 200 });
      return new Response("no", { status: 500 });
    };
    await expect(
      executeLiveSwap({
        env: {
          VALHALLA_LIVE_TRADING: "true",
          VALHALLA_WALLET_SECRET_KEY: bs58.encode(key.secretKey),
          VALHALLA_PUBKEY: key.publicKey.toBase58(),
        },
        side: "buy",
        mint: "So11111111111111111111111111111111111111112",
        sol: 0.01,
        fetchImpl: fetchImpl as typeof fetch,
        sendRaw: async () => "sig",
      })
    ).rejects.toThrow(/Jupiter swap/);
    const sent = calls.join("\n");
    expect(sent).not.toContain("platformFeeBps");
    expect(sent).not.toContain("feeAccount");
  });
});
