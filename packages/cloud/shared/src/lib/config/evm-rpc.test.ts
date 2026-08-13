// Exercises evm rpc behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  listEvmPayoutNetworks,
  payoutEvmChain,
  resolveEvmRpc,
  resolvePayoutEvmRpc,
} from "./evm-rpc";
import { getPayoutTokenConfig, USDC_TESTNET_TOKEN_ADDRESSES } from "./payout-assets";

const ENV_KEYS = [
  "CRYPTO_DIRECT_ETHEREUM_RPC_URL",
  "CRYPTO_DIRECT_BASE_RPC_URL",
  "CRYPTO_DIRECT_BSC_RPC_URL",
  "ETHEREUM_RPC_URL",
  "BASE_RPC_URL",
  "BSC_RPC_URL",
  "X402_ETHEREUM_RPC_URL",
  "X402_BASE_RPC_URL",
  "X402_BSC_RPC_URL",
  "ALCHEMY_API_KEY",
  "INFURA_API_KEY",
  "PAYOUT_TESTNET",
  "SEPOLIA_RPC_URL",
  "BASE_SEPOLIA_RPC_URL",
  "BNB_TESTNET_RPC_URL",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("resolveEvmRpc", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("uses CRYPTO_DIRECT_<NET>_RPC_URL first", () => {
    process.env.CRYPTO_DIRECT_BASE_RPC_URL = "https://crypto-direct.example/base";
    process.env.BASE_RPC_URL = "https://explicit.example/base";
    process.env.ALCHEMY_API_KEY = "k";
    expect(resolveEvmRpc("base")).toEqual({
      url: "https://crypto-direct.example/base",
      source: "crypto_direct",
    });
  });

  test("falls back to <NET>_RPC_URL", () => {
    process.env.BSC_RPC_URL = "https://bsc.example";
    expect(resolveEvmRpc("bnb")).toEqual({
      url: "https://bsc.example",
      source: "explicit",
    });
  });

  test("constructs Alchemy URL when key set and no explicit URL", () => {
    process.env.ALCHEMY_API_KEY = "abc123";
    const r = resolveEvmRpc("ethereum");
    expect(r.source).toBe("alchemy");
    expect(r.url).toBe("https://eth-mainnet.g.alchemy.com/v2/abc123");
  });

  test("constructs Infura URL when only Infura key set", () => {
    process.env.INFURA_API_KEY = "infkey";
    const r = resolveEvmRpc("base");
    expect(r.source).toBe("infura");
    expect(r.url).toBe("https://base-mainnet.infura.io/v3/infkey");
  });

  test("returns chain's public default URL when nothing configured", () => {
    const r = resolveEvmRpc("ethereum");
    expect(r.source).toBe("public_default");
    expect(r.url).toMatch(/^https?:\/\//);
  });

  test("BNB has no Alchemy/Infura mapping, falls through to public", () => {
    process.env.ALCHEMY_API_KEY = "k";
    process.env.INFURA_API_KEY = "k2";
    const r = resolveEvmRpc("bnb");
    expect(r.source).toBe("public_default");
  });

  test("listEvmPayoutNetworks returns all three EVM networks", () => {
    expect(listEvmPayoutNetworks()).toEqual(["ethereum", "base", "bnb"]);
  });

  test("shared resolver remains mainnet-only when payout testnet mode is enabled", () => {
    process.env.PAYOUT_TESTNET = "true";
    process.env.BASE_RPC_URL = "https://mainnet.example/base";
    process.env.BASE_SEPOLIA_RPC_URL = "https://testnet.example/base";

    expect(resolveEvmRpc("base")).toEqual({
      url: "https://mainnet.example/base",
      source: "explicit",
    });
  });

  test("Base staging payout chain, RPC, and USDC contract resolve coherently", () => {
    process.env.PAYOUT_TESTNET = "true";
    process.env.BASE_RPC_URL = "https://mainnet.example/base";
    process.env.BASE_SEPOLIA_RPC_URL = "https://testnet.example/base";

    expect(payoutEvmChain("base").id).toBe(84532);
    expect(resolvePayoutEvmRpc("base")).toEqual({
      url: "https://testnet.example/base",
      source: "explicit",
    });

    const token = getPayoutTokenConfig("base", "usdc");
    expect(token.address).toBe(USDC_TESTNET_TOKEN_ADDRESSES.base);
    expect(token.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(token.decimals).toBe(6);
  });
});
