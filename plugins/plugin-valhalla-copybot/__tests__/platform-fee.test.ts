import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { feeDisclosure, readPlatformFee } from "../src/monetization-trust.ts";
import { feeAccountFor, jupiterQuoteUrl, jupiterSwapBody } from "../src/platform-fee.ts";
import { JUPITER_QUOTE } from "../src/live-swap.ts";

const WSOL = "So11111111111111111111111111111111111111112";

describe("disclosed platform fee", () => {
  it("uses the signed bps and only the receive address fee account", () => {
    const fee = readPlatformFee();
    expect(fee).not.toBeNull();
    expect(fee?.bps).toBe(30);
    expect(feeDisclosure(fee!.bps)).toBe("Platform fee 0.3%");
    expect(fee!.receiveAddress.endsWith("A49f")).toBe(true);
    const account = feeAccountFor(fee!.receiveAddress, WSOL);
    const other = feeAccountFor(PublicKey.unique().toBase58(), WSOL);
    expect(account).not.toBe(other);
    expect(account).toBe(feeAccountFor(fee!.receiveAddress, WSOL));
    const quote = jupiterQuoteUrl({
      endpoint: JUPITER_QUOTE,
      inputMint: WSOL,
      outputMint: WSOL,
      amount: "1000000",
      slippageBps: "1500",
      platformFeeBps: fee!.bps,
    });
    expect(quote.searchParams.get("platformFeeBps")).toBe("30");
    const body = jupiterSwapBody({ quote: {}, userPublicKey: fee!.receiveAddress, feeAccount: account });
    expect(body.feeAccount).toBe(account);
    expect(JSON.stringify(body)).not.toContain(other);
    const raw = JSON.parse(readFileSync(new URL("../monetization.json", import.meta.url), "utf8"));
    raw.platformFeeBps = 99;
    expect(readPlatformFee()?.bps).toBe(30);
  });
});
