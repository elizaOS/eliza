import { describe, expect, test } from "vitest";

import { PrivateKeySchema, loadEnvConfig, type CliOptions } from "./lib";

const baseOpts: CliOptions = {
  execute: false,
  intervalMs: 1,
  iterations: 1,
  orderSize: 1,
  maxPages: 1,
  chain: "polygon",
  rpcUrl: null,
  privateKey: null,
  clobApiUrl: null,
};

describe("PrivateKeySchema", () => {
  test("accepts 0x-prefixed 32-byte hex", () => {
    const key = "0x" + "11".repeat(32);
    const parsed = PrivateKeySchema.parse(key);
    expect(parsed).toBe(key);
  });

  test("adds 0x prefix when missing", () => {
    const keyNoPrefix = "22".repeat(32);
    const parsed = PrivateKeySchema.parse(keyNoPrefix);
    expect(parsed).toBe(`0x${keyNoPrefix}`);
  });

  test("rejects invalid length", () => {
    expect(() => PrivateKeySchema.parse("0x1234")).toThrow();
  });
});

describe("loadEnvConfig", () => {
  test("requires a private key", () => {
    const prev = process.env.EVM_PRIVATE_KEY;
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.POLYMARKET_PRIVATE_KEY;
    delete process.env.WALLET_PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;

    try {
      expect(() => loadEnvConfig(baseOpts)).toThrow();
    } finally {
      if (typeof prev === "string") process.env.EVM_PRIVATE_KEY = prev;
    }
  });

  test("rejects --execute without API creds", () => {
    process.env.EVM_PRIVATE_KEY = "0x" + "33".repeat(32);
    delete process.env.CLOB_API_KEY;
    delete process.env.CLOB_API_SECRET;
    delete process.env.CLOB_API_PASSPHRASE;

    expect(() => loadEnvConfig({ ...baseOpts, execute: true })).toThrow();
  });

  test("uses --private-key and --clob-api-url overrides", () => {
    delete process.env.EVM_PRIVATE_KEY;
    const key = "44".repeat(32);
    const cfg = loadEnvConfig({
      ...baseOpts,
      privateKey: key,
      clobApiUrl: "https://clob.polymarket.com",
    });
    expect(cfg.privateKey).toBe(`0x${key}`);
    expect(cfg.clobApiUrl).toBe("https://clob.polymarket.com");
  });
});

