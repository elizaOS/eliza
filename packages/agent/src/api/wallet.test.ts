/**
 * Covers the wallet key surface of `api/wallet.ts`: EVM/Solana key
 * validation and address derivation, auto-detected validation routing,
 * secret masking, wallet generation, the `importWallet` /
 * `setSolanaWalletEnv` process.env contract, the `getWalletAddresses`
 * source-resolution precedence, and the offline failure boundaries of the
 * Solana RPC balance fetcher.
 *
 * Harness is real: every expectation below was recorded against this exact
 * module (golden derivation vectors), and the network paths are exercised
 * against an unreachable loopback port rather than mocked, so the degrade
 * contracts are the ones a real outage produces.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLOUD_EVM_ADDRESS_ENV_KEY,
  CLOUD_SOLANA_ADDRESS_ENV_KEY,
  deriveEvmAddress,
  deriveSolanaAddress,
  fetchSolanaNativeBalanceViaRpc,
  generateWalletForChain,
  generateWalletKeys,
  getWalletAddresses,
  getWalletAddressesWithSteward,
  importWallet,
  MANAGED_EVM_ADDRESS_ENV_KEY,
  MANAGED_SOLANA_ADDRESS_ENV_KEY,
  maskSecret,
  setSolanaWalletEnv,
  validateEvmPrivateKey,
  validatePrivateKey,
  validateSolanaPrivateKey,
} from "./wallet.ts";

const ENV_KEYS = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "SOLANA_PUBLIC_KEY",
  "WALLET_PUBLIC_KEY",
  "STEWARD_EVM_ADDRESS",
  "STEWARD_SOLANA_ADDRESS",
  "STEWARD_API_URL",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_API_KEY",
  "STEWARD_TENANT_ID",
  MANAGED_EVM_ADDRESS_ENV_KEY,
  MANAGED_SOLANA_ADDRESS_ENV_KEY,
  CLOUD_EVM_ADDRESS_ENV_KEY,
  CLOUD_SOLANA_ADDRESS_ENV_KEY,
  "WALLET_SOURCE_EVM",
  "WALLET_SOURCE_SOLANA",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

// Golden vectors recorded from this module and cross-checked externally:
// 0x…01 is the well-known first secp256k1/keccak address.
const EVM_KEY_01 = `0x${"00".repeat(31)}01`;
const EVM_ADDR_01 = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const EVM_KEY_11 = "11".repeat(32);
const EVM_ADDR_11 = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const EVM_KEY_22 = "22".repeat(32);
const EVM_ADDR_22_CHECKSUMMED = "0x1563915e194D8CfBA1943570603F7606A3115508";

// Base58 inputs recorded alongside their derivations.
const SOL_SECRET_64 =
  "4QuYxZ8wHiUWSRDBNgYuzbk6Bvj6nsHECYn7r4ZSc7mLtNc9M9KaY6CpNYhPvSd9wKJkKVWYDtLWUcUohMoJTa1x";
const SOL_ADDR_64 = "DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC";
const SOL_SECRET_32_SEED = "EnTJCS15dqbDTU2XywYSMaScoPv4Py4GzExrtY9DQxoD";
const SOL_ADDR_32_SEED = "Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r";
const SOL_SECRET_JSON = JSON.stringify([
  ...Array<number>(32).fill(221),
  ...Array<number>(32).fill(238),
]);
const SOL_ADDR_JSON = "H5hM4fqRjygvCYXnp6dgFLgZ6o4uJ8Q9z7dAsTfapHmF";

describe("deriveEvmAddress", () => {
  it("derives the checksummed address for known keys", () => {
    expect(deriveEvmAddress(EVM_KEY_01)).toBe(EVM_ADDR_01);
    expect(deriveEvmAddress(`0x${EVM_KEY_11}`)).toBe(EVM_ADDR_11);
  });

  it("treats a bare 64-hex key identically to its 0x-prefixed form", () => {
    expect(deriveEvmAddress(EVM_KEY_11)).toBe(
      deriveEvmAddress(`0x${EVM_KEY_11}`),
    );
  });

  it("is deterministic per key", () => {
    expect(deriveEvmAddress(EVM_KEY_01)).toBe(deriveEvmAddress(EVM_KEY_01));
  });

  it("emits EIP-55 mixed-case output inside the address charset", () => {
    const address = deriveEvmAddress(EVM_KEY_22);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // A pure-case result would mean the keccak casing nibbles were ignored.
    expect(address).not.toBe(address.toLowerCase());
    expect(address).not.toBe(address.toUpperCase());
    expect(address.toLowerCase()).toBe(EVM_ADDR_22_CHECKSUMMED.toLowerCase());
  });
});

describe("validateEvmPrivateKey", () => {
  it("accepts a valid prefixed key and reports its derived address", () => {
    expect(validateEvmPrivateKey(`0x${EVM_KEY_11}`)).toEqual({
      valid: true,
      chain: "evm",
      address: EVM_ADDR_11,
      error: null,
    });
  });

  it("rejects keys that are not exactly 64 hex characters", () => {
    expect(validateEvmPrivateKey("0x1122")).toEqual({
      valid: false,
      chain: "evm",
      address: null,
      error: "Must be 64 hex characters",
    });
  });

  it("rejects 64-character strings containing non-hex characters", () => {
    expect(validateEvmPrivateKey(`0x${"gg".repeat(32)}`)).toEqual({
      valid: false,
      chain: "evm",
      address: null,
      error: "Invalid hex characters",
    });
  });

  it("agrees with deriveEvmAddress on success", () => {
    expect(validateEvmPrivateKey(EVM_KEY_01).address).toBe(
      deriveEvmAddress(EVM_KEY_01),
    );
  });
});

describe("validateSolanaPrivateKey", () => {
  it("validates a 64-byte base58 secret and returns its pubkey half as address", () => {
    expect(validateSolanaPrivateKey(SOL_SECRET_64)).toEqual({
      valid: true,
      chain: "solana",
      address: SOL_ADDR_64,
      error: null,
    });
    expect(deriveSolanaAddress(SOL_SECRET_64)).toBe(SOL_ADDR_64);
  });

  it("validates a 32-byte base58 seed by deriving its public key", () => {
    expect(validateSolanaPrivateKey(SOL_SECRET_32_SEED)).toEqual({
      valid: true,
      chain: "solana",
      address: SOL_ADDR_32_SEED,
      error: null,
    });
  });

  it("validates the JSON numeric byte-array form", () => {
    expect(validateSolanaPrivateKey(SOL_SECRET_JSON)).toEqual({
      valid: true,
      chain: "solana",
      address: SOL_ADDR_JSON,
      error: null,
    });
  });

  it("rejects a bracketed array containing non-numeric entries", () => {
    expect(validateSolanaPrivateKey('[1,2,"x"]')).toEqual({
      valid: false,
      chain: "solana",
      address: null,
      error: "Invalid key: Error: Invalid JSON byte-array format",
    });
  });

  it("rejects decoded lengths other than 32 or 64 bytes", () => {
    expect(validateSolanaPrivateKey("1234")).toEqual({
      valid: false,
      chain: "solana",
      address: null,
      error: "Must be 32 or 64 bytes, got 3",
    });
  });

  it("reports base58 alphabet violations without throwing", () => {
    expect(validateSolanaPrivateKey("0OIl")).toEqual({
      valid: false,
      chain: "solana",
      address: null,
      error: "Invalid key: Error: Invalid base58: 0",
    });
  });

  it("rejects redaction placeholders", () => {
    expect(validateSolanaPrivateKey("[REDACTED]")).toEqual({
      valid: false,
      chain: "solana",
      address: null,
      error: "Invalid key: Error: placeholder value",
    });
  });
});

describe("validatePrivateKey auto-detection", () => {
  it("routes 0x-prefixed input to the EVM validator even when the hex is bad", () => {
    expect(validatePrivateKey(`0x${"gg".repeat(32)}`)).toEqual({
      valid: false,
      chain: "evm",
      address: null,
      error: "Invalid hex characters",
    });
  });

  it("routes unprefixed 64-char hex to the EVM validator", () => {
    const result = validatePrivateKey(EVM_KEY_11);
    expect(result.chain).toBe("evm");
    expect(result.valid).toBe(true);
  });

  it("routes shorter hex strings to the Solana length check", () => {
    expect(validatePrivateKey("ab".repeat(31))).toEqual({
      valid: false,
      chain: "solana",
      address: null,
      error: "Must be 32 or 64 bytes, got 46",
    });
  });

  it("routes base58 secrets to a successful Solana validation", () => {
    const result = validatePrivateKey(SOL_SECRET_64);
    expect(result.chain).toBe("solana");
    expect(result.valid).toBe(true);
    expect(result.address).toBe(SOL_ADDR_64);
  });
});

describe("maskSecret", () => {
  it("fully masks empty and at-most-8-character secrets", () => {
    expect(maskSecret("")).toBe("****");
    expect(maskSecret("12345678")).toBe("****");
  });

  it("keeps exactly the first and last four characters past the boundary", () => {
    expect(maskSecret("123456789")).toBe("1234...6789");
    expect(maskSecret(SOL_SECRET_64)).toBe(
      `${SOL_SECRET_64.slice(0, 4)}...${SOL_SECRET_64.slice(-4)}`,
    );
  });
});

describe("generateWalletKeys and generateWalletForChain", () => {
  it("generates a pair whose halves validate back to the reported addresses", () => {
    const keys = generateWalletKeys();
    const evm = validateEvmPrivateKey(keys.evmPrivateKey);
    const solana = validateSolanaPrivateKey(keys.solanaPrivateKey);
    expect(evm).toMatchObject({ valid: true, address: keys.evmAddress });
    expect(solana).toMatchObject({
      valid: true,
      address: keys.solanaAddress,
    });
    expect(keys.evmPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("does not repeat itself across generations", () => {
    const first = generateWalletKeys();
    const second = generateWalletKeys();
    expect(first.evmPrivateKey).not.toBe(second.evmPrivateKey);
    expect(first.solanaPrivateKey).not.toBe(second.solanaPrivateKey);
  });

  it("generates per-chain wallets that survive their own validators", () => {
    const evm = generateWalletForChain("evm");
    expect(evm.chain).toBe("evm");
    expect(validateEvmPrivateKey(evm.privateKey)).toMatchObject({
      valid: true,
      address: evm.address,
    });

    const solana = generateWalletForChain("solana");
    expect(solana.chain).toBe("solana");
    expect(validateSolanaPrivateKey(solana.privateKey)).toMatchObject({
      valid: true,
      address: solana.address,
    });
  });
});

describe("importWallet env contract", () => {
  it("stores a raw EVM key trimmed and normalized with the 0x prefix", () => {
    const result = importWallet("evm", `  ${EVM_KEY_22}  `);
    expect(result).toEqual({
      success: true,
      chain: "evm",
      address: EVM_ADDR_22_CHECKSUMMED,
      error: null,
    });
    expect(process.env.EVM_PRIVATE_KEY).toBe(`0x${EVM_KEY_22}`);
  });

  it("stores an already-prefixed EVM key unchanged", () => {
    importWallet("evm", EVM_KEY_01);
    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_KEY_01);
  });

  it("leaves the environment untouched when the EVM key is invalid", () => {
    process.env.EVM_PRIVATE_KEY = "sentinel";
    const result = importWallet("evm", "nothex");
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(process.env.EVM_PRIVATE_KEY).toBe("sentinel");
  });

  it("mirrors a valid Solana secret into the public-key env slots", () => {
    const result = importWallet("solana", ` ${SOL_SECRET_JSON} `);
    expect(result).toEqual({
      success: true,
      chain: "solana",
      address: SOL_ADDR_JSON,
      error: null,
    });
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(SOL_SECRET_JSON);
    expect(process.env.SOLANA_PUBLIC_KEY).toBe(SOL_ADDR_JSON);
    expect(process.env.WALLET_PUBLIC_KEY).toBe(SOL_ADDR_JSON);
  });

  it("leaves the environment untouched when the Solana key is invalid", () => {
    process.env.SOLANA_PRIVATE_KEY = "sentinel";
    const result = importWallet("solana", "0OIl");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid base58");
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("sentinel");
  });
});

describe("setSolanaWalletEnv", () => {
  it("returns the derived public key and populates both public slots", () => {
    expect(setSolanaWalletEnv(SOL_SECRET_JSON)).toBe(SOL_ADDR_JSON);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(SOL_SECRET_JSON);
    expect(process.env.SOLANA_PUBLIC_KEY).toBe(SOL_ADDR_JSON);
    expect(process.env.WALLET_PUBLIC_KEY).toBe(SOL_ADDR_JSON);
  });

  it("writes the trimmed value even when derivation fails and returns null", () => {
    expect(setSolanaWalletEnv("  garbage!!  ")).toBeNull();
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("garbage!!");
    expect(process.env.SOLANA_PUBLIC_KEY).toBeUndefined();
  });
});

describe("getWalletAddresses resolution order", () => {
  it("resolves nothing when no wallet configuration exists", () => {
    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
  });

  it("prefers steward addresses over locally derived keys in legacy mode", () => {
    process.env.STEWARD_EVM_ADDRESS =
      "0xabababababababababababababababababababab";
    process.env.STEWARD_SOLANA_ADDRESS = SOL_ADDR_32_SEED;
    process.env.EVM_PRIVATE_KEY = EVM_KEY_11;
    process.env.SOLANA_PRIVATE_KEY = SOL_SECRET_JSON;
    expect(getWalletAddresses()).toEqual({
      evmAddress: "0xabababababababababababababababababababab",
      solanaAddress: SOL_ADDR_32_SEED,
    });
  });

  it("falls back to managed addresses when steward and local keys are absent", () => {
    process.env[MANAGED_EVM_ADDRESS_ENV_KEY] =
      "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    process.env[MANAGED_SOLANA_ADDRESS_ENV_KEY] = SOL_ADDR_64;
    expect(getWalletAddresses()).toEqual({
      evmAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      solanaAddress: SOL_ADDR_64,
    });
  });

  it("prefers cloud addresses over managed ones when the cloud source is selected", () => {
    process.env.WALLET_SOURCE_EVM = "cloud";
    process.env.WALLET_SOURCE_SOLANA = "cloud";
    process.env[CLOUD_EVM_ADDRESS_ENV_KEY] =
      "0xefefefefefefefefefefefefefefefefefefefef";
    process.env[CLOUD_SOLANA_ADDRESS_ENV_KEY] = SOL_ADDR_32_SEED;
    process.env[MANAGED_EVM_ADDRESS_ENV_KEY] =
      "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    process.env[MANAGED_SOLANA_ADDRESS_ENV_KEY] = SOL_ADDR_64;
    expect(getWalletAddresses()).toEqual({
      evmAddress: "0xefefefefefefefefefefefefefefefefefefefef",
      solanaAddress: SOL_ADDR_32_SEED,
    });
  });

  it("uses managed addresses when the cloud source yields nothing", () => {
    process.env.WALLET_SOURCE_EVM = "cloud";
    process.env.WALLET_SOURCE_SOLANA = "cloud";
    process.env[MANAGED_EVM_ADDRESS_ENV_KEY] =
      "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    process.env[MANAGED_SOLANA_ADDRESS_ENV_KEY] = SOL_ADDR_64;
    expect(getWalletAddresses()).toEqual({
      evmAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      solanaAddress: SOL_ADDR_64,
    });
  });

  it("derives from local keys when the local source is selected", () => {
    process.env.WALLET_SOURCE_EVM = "local";
    process.env.WALLET_SOURCE_SOLANA = "local";
    process.env.EVM_PRIVATE_KEY = EVM_KEY_22;
    process.env.SOLANA_PRIVATE_KEY = SOL_SECRET_JSON;
    expect(getWalletAddresses()).toEqual({
      evmAddress: EVM_ADDR_22_CHECKSUMMED,
      solanaAddress: SOL_ADDR_JSON,
    });
  });

  it("reports null for an unusable local key instead of falling back", () => {
    process.env.WALLET_SOURCE_EVM = "local";
    process.env.WALLET_SOURCE_SOLANA = "local";
    process.env.EVM_PRIVATE_KEY = "nothex";
    process.env.SOLANA_PRIVATE_KEY = "0OIl";
    process.env[MANAGED_EVM_ADDRESS_ENV_KEY] =
      "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    process.env[MANAGED_SOLANA_ADDRESS_ENV_KEY] = SOL_ADDR_64;
    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
  });

  it("treats an unrecognized source value as unconfigured for legacy fallback", () => {
    process.env.WALLET_SOURCE_EVM = "bogus";
    process.env.WALLET_SOURCE_SOLANA = "local";
    process.env[MANAGED_EVM_ADDRESS_ENV_KEY] =
      "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    process.env[MANAGED_SOLANA_ADDRESS_ENV_KEY] = SOL_ADDR_64;
    process.env.EVM_PRIVATE_KEY = "nothex";
    process.env.SOLANA_PRIVATE_KEY = "0OIl";
    expect(getWalletAddresses()).toEqual({
      evmAddress: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      solanaAddress: null,
    });
  });

  it("ignores malformed steward addresses rather than passing them through", () => {
    process.env.STEWARD_EVM_ADDRESS = "not-an-address";
    process.env.STEWARD_SOLANA_ADDRESS = "0OIl";
    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
  });
});

describe("getWalletAddressesWithSteward offline boundaries", () => {
  it("returns exactly the base addresses when no steward API is configured", async () => {
    const result = await getWalletAddressesWithSteward();
    expect(result).toEqual({ evmAddress: null, solanaAddress: null });
    expect("stewardEvmAddress" in result).toBe(false);
    expect("stewardSolanaAddress" in result).toBe(false);
  });

  it("degrades to the base addresses when the steward lookup cannot connect", async () => {
    process.env.EVM_PRIVATE_KEY = EVM_KEY_22;
    process.env.STEWARD_API_URL = "http://127.0.0.1:1";
    process.env.STEWARD_AGENT_ID = "agent-under-test";

    const result = await getWalletAddressesWithSteward();
    expect(result).toEqual({
      evmAddress: EVM_ADDR_22_CHECKSUMMED,
      solanaAddress: null,
    });
  });
});

describe("fetchSolanaNativeBalanceViaRpc failure aggregation", () => {
  it("throws the RPC-unavailable sentinel when no URLs are configured", async () => {
    await expect(fetchSolanaNativeBalanceViaRpc("addr", [])).rejects.toThrow(
      "Solana RPC unavailable",
    );
  });

  it("ignores blank URLs entirely", async () => {
    await expect(
      fetchSolanaNativeBalanceViaRpc("addr", ["", "   "]),
    ).rejects.toThrow("Solana RPC unavailable");
  });

  it("aggregates per-endpoint failures in request order", async () => {
    let message: string | undefined;
    try {
      await fetchSolanaNativeBalanceViaRpc("addr", [
        "http://127.0.0.1:1",
        "http://127.0.0.1:2",
      ]);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toBeDefined();
    // Only the host labels come from the module; the inner transport text is
    // runtime-specific, so assert structure rather than exact wording.
    expect(message).toContain("127.0.0.1:1:");
    expect(message).toContain("127.0.0.1:2:");
    expect(message?.indexOf("127.0.0.1:1:")).toBeLessThan(
      message?.indexOf("127.0.0.1:2:") ?? Number.POSITIVE_INFINITY,
    );
    expect(message).toContain(" | ");
  });
});
