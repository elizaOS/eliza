/** Exercises real wallet generation, validation, import and environment readback across the configuration-safe leaf and public wallet service; no cryptography or storage is mocked. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  generateWalletForChain,
  importWallet,
  validatePrivateKey,
} from "../src/api/wallet.ts";
import {
  deriveEvmAddress,
  deriveSolanaAddress,
  generateWalletKeys,
  syncSolanaPublicKeyEnv,
} from "../src/api/wallet-keygen.ts";
import { loadElizaConfig } from "../src/config/config.ts";

afterEach(() => vi.unstubAllEnvs());

it("round-trips generated keys through import and the shared public-address derivation", () => {
  for (const key of [
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "SOLANA_PUBLIC_KEY",
    "WALLET_PUBLIC_KEY",
  ])
    vi.stubEnv(key, undefined);
  const keys = generateWalletKeys();
  expect(deriveEvmAddress(keys.evmPrivateKey)).toBe(keys.evmAddress);
  expect(deriveSolanaAddress(keys.solanaPrivateKey)).toBe(keys.solanaAddress);
  for (const chain of ["evm", "solana"] as const) {
    const generated = generateWalletForChain(chain);
    const validation = validatePrivateKey(generated.privateKey);
    expect(validation.valid).toBe(true);
    expect(validation.address).toBe(generated.address);
    const imported = importWallet(chain, generated.privateKey);
    expect(imported.success).toBe(true);
    expect(imported.address).toBe(generated.address);
    if (chain === "solana") {
      expect(syncSolanaPublicKeyEnv()).toBe(generated.address);
      expect(process.env.SOLANA_PUBLIC_KEY).toBe(generated.address);
      expect(process.env.WALLET_PUBLIC_KEY).toBe(generated.address);
    }
  }
});

it("keeps malformed and oversized secret inputs out of the environment", () => {
  vi.stubEnv("SOLANA_PRIVATE_KEY", "existing-private-key");
  vi.stubEnv("SOLANA_PUBLIC_KEY", "existing-public-key");
  for (const secret of ["[REDACTED]", "invalid!", "1".repeat(10_000)]) {
    expect(importWallet("solana", secret).success).toBe(false);
    expect(syncSolanaPublicKeyEnv(secret)).toBeNull();
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("existing-private-key");
    expect(process.env.SOLANA_PUBLIC_KEY).toBe("existing-public-key");
  }
});

it.each([
  { network: "", environment: "testnet", expected: "testnet" },
  { network: "   ", environment: "testnet", expected: "testnet" },
  { network: "mainnet", environment: "testnet", expected: "mainnet" },
  { network: "testnet", environment: "mainnet", expected: "testnet" },
  { network: "", environment: "   ", expected: "mainnet" },
  { network: "invalid-network", environment: "testnet", expected: null },
  { network: "", environment: "invalid-network", expected: null },
])(
  "serves the actual configured wallet network over authenticated HTTP: $network/$environment",
  async ({ network, environment, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-network-http-"));
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      const filename = join(directory, "eliza.json");
      const token = randomUUID();
      for (const [key, value] of Object.entries({
        ELIZA_STATE_DIR: directory,
        ELIZA_CONFIG_PATH: filename,
        ELIZA_PERSIST_CONFIG_PATH: filename,
        ELIZA_API_BIND_HOST: "127.0.0.1",
        ELIZA_API_TOKEN: token,
        ELIZA_REQUIRE_LOCAL_AUTH: "1",
        ELIZA_WALLET_AUTO_PROVISION: "0",
        ELIZA_WALLET_NETWORK: environment,
      }))
        vi.stubEnv(key, value);
      for (const key of [
        "ELIZAOS_CLOUD_API_KEY",
        "EVM_PRIVATE_KEY",
        "SOLANA_PRIVATE_KEY",
        "SOLANA_PUBLIC_KEY",
        "WALLET_PUBLIC_KEY",
      ])
        vi.stubEnv(key, undefined);
      await writeFile(filename, JSON.stringify({ wallet: { network } }));
      const hostConfig = loadElizaConfig();
      server = await startApiServer({
        port: 0,
        hostConfig,
        skipDeferredStartupWork: true,
      });
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/wallet/config`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (expected === null) {
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining("Invalid wallet network"),
        });
      } else {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          walletNetwork: expected,
        });
      }
      const rejected = await fetch(
        `http://127.0.0.1:${server.port}/api/wallet/config`,
      );
      expect(rejected.status).toBe(401);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
