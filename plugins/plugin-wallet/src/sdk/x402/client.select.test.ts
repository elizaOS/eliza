/**
 * X402Client payment selection under a spend cap. Caps are USDC base units,
 * so a capped client must never pick another token's offer and compare its
 * raw amount (0.009 WBTC = 900000) against a USDC cap (1.00 = 1000000).
 */
import { describe, expect, it } from "vitest";
import { X402Client } from "./client";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WBTC = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";
const offer = (asset: string, amount: string) => ({
  scheme: "exact",
  network: "base:8453",
  asset,
  amount,
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 60,
  extra: {},
});
const wallet = {} as unknown as import("../wallet-core").AgentWallet;
const offers = [offer(USDC, "1000000"), offer(WBTC, "900000")];

describe("X402Client.selectPaymentOption with a spend cap", () => {
  it("pays in USDC when no asset list is set", () => {
    const client = new X402Client(wallet, { globalPerRequestMax: 1_000_000n });
    expect(client.selectPaymentOption(offers)?.asset).toBe(USDC);
    expect(client.selectPaymentOption([offer(WBTC, "900000")])).toBeNull();
  });

  it("pays in USDC when the asset list also names another token", () => {
    const client = new X402Client(wallet, {
      globalPerRequestMax: 1_000_000n,
      supportedAssets: { "base:8453": [USDC, WBTC] },
    });
    expect(client.selectPaymentOption(offers)?.asset).toBe(USDC);
  });

  it("pays nothing on a network with no known USDC", () => {
    const token = "0x1111111111111111111111111111111111111111";
    const client = new X402Client(wallet, {
      globalPerRequestMax: 1_000_000n,
      supportedNetworks: ["zora:7777777"],
      supportedAssets: { "zora:7777777": [token] },
    });
    expect(
      client.selectPaymentOption([
        { ...offer(token, "900000"), network: "zora:7777777" },
      ]),
    ).toBeNull();
  });

  it("keeps the lowest offer when no cap is set", () => {
    const client = new X402Client(wallet, {
      supportedAssets: { "base:8453": [USDC, WBTC] },
    });
    expect(client.selectPaymentOption(offers)?.asset).toBe(WBTC);
  });
});
