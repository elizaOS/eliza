import { describe, expect, it } from "vitest";
import { walletPlugin } from "./plugin";

describe("walletPlugin route contract", () => {
  it("exposes both EVM and Solana browser signing routes through the aggregate plugin", () => {
    const routeNames =
      walletPlugin.routes?.map((route) => route.name).filter(Boolean) ?? [];

    expect(routeNames).toEqual(
      expect.arrayContaining([
        "wallet-evm-address",
        "wallet-evm-personal-sign",
        "wallet-evm-sign-typed-data",
        "wallet-evm-sign-transaction",
        "wallet-evm-send-transaction",
        "wallet-solana-pubkey",
        "wallet-solana-sign-message",
        "wallet-solana-sign-transaction",
        "wallet-solana-sign-all-transactions",
        "wallet-solana-sign-and-send-transaction",
      ]),
    );
  });
});
