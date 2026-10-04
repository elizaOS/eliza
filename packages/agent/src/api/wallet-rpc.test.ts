/**
 * Covers resolveWalletNetworkMode: explicit default, case-insensitive
 * variants, fallback-over-config precedence, and typed rejection of invalid
 * explicit values. Deterministic; mutates ELIZA_WALLET_NETWORK per case.
 */

import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWalletNetworkMode } from "./wallet-rpc.ts";

type NetworkConfig = Parameters<typeof resolveWalletNetworkMode>[0];

function configWith(network: unknown): NetworkConfig {
  return { wallet: { network } } as unknown as NetworkConfig;
}

const inheritedNetwork = process.env.ELIZA_WALLET_NETWORK;

beforeEach(() => {
  delete process.env.ELIZA_WALLET_NETWORK;
});

afterEach(() => {
  if (inheritedNetwork === undefined) {
    delete process.env.ELIZA_WALLET_NETWORK;
  } else {
    process.env.ELIZA_WALLET_NETWORK = inheritedNetwork;
  }
});

describe("resolveWalletNetworkMode", () => {
  it("defaults to mainnet when all sources are unset or blank", () => {
    expect(resolveWalletNetworkMode()).toBe("mainnet");
    expect(resolveWalletNetworkMode(null)).toBe("mainnet");
    expect(resolveWalletNetworkMode(configWith(""))).toBe("mainnet");
    expect(resolveWalletNetworkMode(configWith("   "))).toBe("mainnet");
    expect(resolveWalletNetworkMode(undefined, "")).toBe("mainnet");
    process.env.ELIZA_WALLET_NETWORK = "   ";
    expect(resolveWalletNetworkMode()).toBe("mainnet");
  });

  it("accepts mainnet variants case-insensitively with trimming", () => {
    expect(resolveWalletNetworkMode(configWith("mainnet"))).toBe("mainnet");
    expect(resolveWalletNetworkMode(configWith("MAINNET"))).toBe("mainnet");
    expect(resolveWalletNetworkMode(configWith(" MainNet "))).toBe("mainnet");
    process.env.ELIZA_WALLET_NETWORK = "MAINNET";
    expect(resolveWalletNetworkMode()).toBe("mainnet");
  });

  it("accepts testnet variants case-insensitively with trimming", () => {
    expect(resolveWalletNetworkMode(configWith("testnet"))).toBe("testnet");
    expect(resolveWalletNetworkMode(configWith("TESTNET"))).toBe("testnet");
    expect(resolveWalletNetworkMode(configWith(" testnet "))).toBe("testnet");
    process.env.ELIZA_WALLET_NETWORK = " testnet ";
    expect(resolveWalletNetworkMode()).toBe("testnet");
  });

  it("skips blank sources instead of letting them hide a later value", () => {
    process.env.ELIZA_WALLET_NETWORK = "testnet";
    expect(resolveWalletNetworkMode(configWith(""))).toBe("testnet");
    expect(resolveWalletNetworkMode(configWith("   "))).toBe("testnet");
    expect(resolveWalletNetworkMode(configWith("mainnet"), "")).toBe("mainnet");
    expect(resolveWalletNetworkMode(undefined, "  ")).toBe("testnet");
  });

  it("prefers fallback over config and config over the environment", () => {
    process.env.ELIZA_WALLET_NETWORK = "testnet";
    expect(resolveWalletNetworkMode(configWith("mainnet"), "testnet")).toBe(
      "testnet",
    );
    expect(resolveWalletNetworkMode(configWith("testnet"))).toBe("testnet");
    expect(resolveWalletNetworkMode()).toBe("testnet");
  });

  it("throws a typed error naming the value and source for typos", () => {
    const cases: Array<{
      label: string;
      args: [NetworkConfig?, string?];
      value: string;
      source: string;
    }> = [
      {
        label: "config typo",
        args: [configWith("MAINET")],
        value: "MAINET",
        source: "config.wallet.network",
      },
      {
        label: "config wrong network",
        args: [configWith("devnet")],
        value: "devnet",
        source: "config.wallet.network",
      },
      {
        label: "fallback typo",
        args: [undefined, "banana"],
        value: "banana",
        source: "fallback",
      },
    ];
    for (const { args, value, source } of cases) {
      let error: unknown;
      try {
        resolveWalletNetworkMode(...args);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(ElizaError);
      const typed = error as ElizaError;
      expect(typed.code).toBe("WALLET_NETWORK_INVALID");
      expect(typed.message).toContain(value);
      expect(typed.message).toContain(source);
      expect(typed.context).toMatchObject({ received: value, source });
    }
  });

  it("throws for an invalid ELIZA_WALLET_NETWORK value", () => {
    process.env.ELIZA_WALLET_NETWORK = "MAINET";
    let error: unknown;
    try {
      resolveWalletNetworkMode();
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("WALLET_NETWORK_INVALID");
    expect((error as ElizaError).message).toContain("MAINET");
    expect((error as ElizaError).message).toContain("ELIZA_WALLET_NETWORK");
  });
});
