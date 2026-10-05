/** Exercises real wallet generation, validation, import and environment readback across the configuration-safe leaf and public wallet service; no cryptography or storage is mocked. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
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
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";

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

it.each([
  { osStore: "1", vault: "ok", route: "generate", chain: "both", status: 200 },
  { osStore: "1", vault: "ok", route: "import", chain: "evm", status: 200 },
  { osStore: "1", vault: "none", route: "generate", chain: "evm", status: 500 },
  { osStore: "1", vault: "none", route: "import", chain: "evm", status: 500 },
  {
    osStore: "1",
    vault: "rejects-solana",
    route: "generate",
    chain: "both",
    status: 500,
  },
  { osStore: "0", vault: "none", route: "generate", chain: "evm", status: 200 },
] as const)(
  "keeps local wallet keys restorable: $route $chain, ELIZA_WALLET_OS_STORE=$osStore, vault $vault",
  async ({ osStore, vault, route, chain, status }) => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-key-store-http-"));
    const savedBridge = getAgentHostBridge();
    let testVault: TestVault | undefined;
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
      }))
        vi.stubEnv(key, value);
      for (const key of [
        "ELIZA_WALLET_OS_STORE",
        "ELIZAOS_CLOUD_API_KEY",
        "STEWARD_API_URL",
        "EVM_PRIVATE_KEY",
        "SOLANA_PRIVATE_KEY",
        "SOLANA_PUBLIC_KEY",
        "WALLET_PUBLIC_KEY",
      ])
        vi.stubEnv(key, undefined);
      const previousEvmKey = generateWalletForChain("evm").privateKey;
      if (vault !== "none") {
        testVault = await createTestVault();
        const realVault = testVault.vault;
        await realVault.set("EVM_PRIVATE_KEY", previousEvmKey, {
          sensitive: true,
        });
        const sharedVault =
          vault === "rejects-solana"
            ? new Proxy(realVault, {
                get(target, property) {
                  if (property === "set") {
                    return async (key: string, ...rest: unknown[]) => {
                      if (key === "SOLANA_PRIVATE_KEY") {
                        throw new Error("keychain denied");
                      }
                      return (
                        target.set as (...args: unknown[]) => Promise<void>
                      )(key, ...rest);
                    };
                  }
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              })
            : realVault;
        setAgentHostBridge({ ...savedBridge, sharedVault: () => sharedVault });
      }
      await writeFile(
        filename,
        JSON.stringify({ env: { ELIZA_WALLET_OS_STORE: osStore } }),
      );
      server = await startApiServer({
        port: 0,
        hostConfig: loadElizaConfig(),
        skipDeferredStartupWork: true,
      });
      const importedKey = generateWalletForChain("evm").privateKey;
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/wallet/${route}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            route === "import"
              ? { chain, privateKey: importedKey }
              : { chain, source: "local" },
          ),
        },
      );
      expect(response.status).toBe(status);
      const persisted = JSON.parse(await readFile(filename, "utf8"));
      if (status !== 200) {
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining(
            vault === "none" ? "WALLET_OS_STORE" : "keychain denied",
          ),
        });
        expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
        expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
        expect(persisted.env.EVM_PRIVATE_KEY).toBeUndefined();
        if (testVault) {
          expect(await testVault.vault.reveal("EVM_PRIVATE_KEY")).toBe(
            previousEvmKey,
          );
          expect(await testVault.vault.has("SOLANA_PRIVATE_KEY")).toBe(false);
        }
        return;
      }
      const activeKey = process.env.EVM_PRIVATE_KEY;
      expect(activeKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
      if (route === "import") expect(activeKey).toBe(importedKey);
      if (!testVault) {
        expect(persisted.env.EVM_PRIVATE_KEY).toBe(activeKey);
        return;
      }
      expect(persisted.env.EVM_PRIVATE_KEY).toBeUndefined();
      expect(persisted.env.SOLANA_PRIVATE_KEY).toBeUndefined();
      expect(await testVault.vault.reveal("EVM_PRIVATE_KEY")).toBe(activeKey);
      if (chain === "both") {
        expect(process.env.SOLANA_PRIVATE_KEY).toBeTruthy();
        expect(await testVault.vault.reveal("SOLANA_PRIVATE_KEY")).toBe(
          process.env.SOLANA_PRIVATE_KEY,
        );
      }
    } finally {
      setAgentHostBridge(savedBridge);
      await server?.close();
      await testVault?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// Concurrent HTTP requests share process wallet state and one host vault.
it.each(["import", "provision"])(
  "a failed %s cannot roll back a later successful import",
  async (firstRoute) => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-concurrent-http-"));
    const savedBridge = getAgentHostBridge();
    const testVault = await createTestVault();
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
      }))
        vi.stubEnv(key, value);
      for (const key of [
        "ELIZA_WALLET_OS_STORE",
        "ELIZAOS_CLOUD_API_KEY",
        "STEWARD_API_URL",
        "EVM_PRIVATE_KEY",
        "SOLANA_PRIVATE_KEY",
        "SOLANA_PUBLIC_KEY",
        "WALLET_PUBLIC_KEY",
      ])
        vi.stubEnv(key, undefined);
      const firstKey = generateWalletForChain("evm").privateKey;
      const secondKey = generateWalletForChain("evm").privateKey;
      let entered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const realVault = testVault.vault;
      const vault = new Proxy(realVault, {
        get(target, property) {
          if (property === "set")
            return async (key: string, value: string, ...rest: unknown[]) => {
              if (
                value === firstKey ||
                (firstRoute === "provision" &&
                  key === "EVM_PRIVATE_KEY" &&
                  value !== secondKey)
              ) {
                entered();
                await new Promise((resolve) => setTimeout(resolve, 300));
                throw new Error("first import denied");
              }
              return (target.set as (...args: unknown[]) => Promise<void>)(
                key,
                value,
                ...rest,
              );
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      setAgentHostBridge({ ...savedBridge, sharedVault: () => vault });
      await writeFile(
        filename,
        JSON.stringify({ env: { ELIZA_WALLET_OS_STORE: "1" } }),
      );
      server = await startApiServer({
        port: 0,
        hostConfig: loadElizaConfig(),
        skipDeferredStartupWork: true,
      });
      // Load the optional wallet route before opening the concurrency window.
      const warm = await fetch(
        `http://127.0.0.1:${server.port}/api/wallet/config`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(warm.status).toBe(200);
      const request = (privateKey: string) =>
        fetch(`http://127.0.0.1:${server!.port}/api/wallet/import`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ chain: "evm", privateKey }),
        });
      const first =
        firstRoute === "import"
          ? request(firstKey)
          : fetch(`http://127.0.0.1:${server.port}/api/wallet/keys`, {
              headers: { Authorization: `Bearer ${token}` },
            });
      await firstEntered;
      const second = request(secondKey);
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([500, 200]);
      // Boolean assertions keep ephemeral private keys out of failure output.
      expect(process.env.EVM_PRIVATE_KEY === secondKey).toBe(true);
      expect(await realVault.has("EVM_PRIVATE_KEY")).toBe(true);
      expect((await realVault.reveal("EVM_PRIVATE_KEY")) === secondKey).toBe(
        true,
      );
    } finally {
      await server?.close();
      setAgentHostBridge(savedBridge);
      await testVault.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  { entry: "first-run keys route", vault: true },
  { entry: "first-run keys route", vault: false },
  { entry: "first-run completion", vault: false },
  { entry: "boot auto-provision", vault: true },
  { entry: "boot auto-provision", vault: false },
] as const)(
  "provisions wallet keys durably in OS-store mode via $entry (vault: $vault)",
  async ({ entry, vault }) => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-provision-http-"));
    const savedBridge = getAgentHostBridge();
    let testVault: TestVault | undefined;
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
        ELIZA_WALLET_AUTO_PROVISION:
          entry === "boot auto-provision" ? "1" : "0",
      }))
        vi.stubEnv(key, value);
      for (const key of [
        "ELIZA_WALLET_OS_STORE",
        "ELIZAOS_CLOUD_API_KEY",
        "STEWARD_API_URL",
        "EVM_PRIVATE_KEY",
        "SOLANA_PRIVATE_KEY",
        "SOLANA_PUBLIC_KEY",
        "WALLET_PUBLIC_KEY",
      ])
        vi.stubEnv(key, undefined);
      if (vault) {
        testVault = await createTestVault();
        const sharedVault = testVault.vault;
        setAgentHostBridge({ ...savedBridge, sharedVault: () => sharedVault });
      }
      await writeFile(
        filename,
        JSON.stringify({ env: { ELIZA_WALLET_OS_STORE: "1" } }),
      );
      server = await startApiServer({
        port: 0,
        hostConfig: loadElizaConfig(),
        skipDeferredStartupWork: true,
      });
      if (
        entry === "first-run keys route" ||
        entry === "first-run completion"
      ) {
        const response = await fetch(
          `http://127.0.0.1:${server.port}${entry === "first-run completion" ? "/api/first-run" : "/api/wallet/keys"}`,
          {
            method: entry === "first-run completion" ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            ...(entry === "first-run completion"
              ? { body: JSON.stringify({ name: "Wallet fixture" }) }
              : {}),
          },
        );
        expect(response.status).toBe(vault ? 200 : 500);
      }
      const persisted = JSON.parse(await readFile(filename, "utf8"));
      expect(persisted.env.EVM_PRIVATE_KEY).toBeUndefined();
      expect(persisted.env.SOLANA_PRIVATE_KEY).toBeUndefined();
      if (!testVault) {
        expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
        expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
        return;
      }
      expect(process.env.EVM_PRIVATE_KEY).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(await testVault.vault.reveal("EVM_PRIVATE_KEY")).toBe(
        process.env.EVM_PRIVATE_KEY,
      );
      expect(await testVault.vault.reveal("SOLANA_PRIVATE_KEY")).toBe(
        process.env.SOLANA_PRIVATE_KEY,
      );
    } finally {
      setAgentHostBridge(savedBridge);
      await server?.close();
      await testVault?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// A reset clears first-run state but deliberately keeps wallet vault keys, and
// the boot-time vault→env hydrate only runs after the API listener is live.
// Every provisioning entry point must therefore reuse the stored wallet
// instead of treating blank env vars as a missing wallet and overwriting it.
it.each([
  { entry: "first-run keys route" },
  { entry: "first-run completion" },
  { entry: "boot auto-provision" },
] as const)(
  "reuses vault-held wallet keys instead of overwriting them via $entry",
  async ({ entry }) => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-vault-reuse-"));
    const savedBridge = getAgentHostBridge();
    const testVault = await createTestVault();
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
        ELIZA_WALLET_AUTO_PROVISION:
          entry === "boot auto-provision" ? "1" : "0",
      }))
        vi.stubEnv(key, value);
      for (const key of [
        "ELIZA_WALLET_OS_STORE",
        "ELIZAOS_CLOUD_API_KEY",
        "STEWARD_API_URL",
        "EVM_PRIVATE_KEY",
        "SOLANA_PRIVATE_KEY",
        "SOLANA_PUBLIC_KEY",
        "WALLET_PUBLIC_KEY",
      ])
        vi.stubEnv(key, undefined);
      // The prior install's funded wallet survived the reset in the vault.
      const priorEvm = generateWalletForChain("evm");
      const priorSolana = generateWalletForChain("solana");
      await testVault.vault.set("EVM_PRIVATE_KEY", priorEvm.privateKey, {
        sensitive: true,
      });
      await testVault.vault.set("SOLANA_PRIVATE_KEY", priorSolana.privateKey, {
        sensitive: true,
      });
      setAgentHostBridge({
        ...savedBridge,
        sharedVault: () => testVault.vault,
      });
      await writeFile(
        filename,
        JSON.stringify({ env: { ELIZA_WALLET_OS_STORE: "1" } }),
      );
      server = await startApiServer({
        port: 0,
        hostConfig: loadElizaConfig(),
        skipDeferredStartupWork: true,
      });
      if (entry !== "boot auto-provision") {
        const response = await fetch(
          `http://127.0.0.1:${server.port}${entry === "first-run completion" ? "/api/first-run" : "/api/wallet/keys"}`,
          {
            method: entry === "first-run completion" ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            ...(entry === "first-run completion"
              ? { body: JSON.stringify({ name: "Wallet fixture" }) }
              : {}),
          },
        );
        expect(response.status).toBe(200);
        if (entry === "first-run keys route") {
          const body = (await response.json()) as {
            evmAddress: string;
            solanaAddress: string;
          };
          // The re-onboarding user is shown the stored wallet's addresses.
          expect(body.evmAddress).toBe(priorEvm.address);
          expect(body.solanaAddress).toBe(priorSolana.address);
        }
      }
      // Boolean assertions keep ephemeral private keys out of failure output.
      expect(
        (await testVault.vault.reveal("EVM_PRIVATE_KEY")) ===
          priorEvm.privateKey,
      ).toBe(true);
      expect(
        (await testVault.vault.reveal("SOLANA_PRIVATE_KEY")) ===
          priorSolana.privateKey,
      ).toBe(true);
      expect(process.env.EVM_PRIVATE_KEY === priorEvm.privateKey).toBe(true);
      expect(process.env.SOLANA_PRIVATE_KEY === priorSolana.privateKey).toBe(
        true,
      );
      expect(process.env.SOLANA_PUBLIC_KEY === priorSolana.address).toBe(true);
      expect(process.env.WALLET_PUBLIC_KEY === priorSolana.address).toBe(true);
      const persisted = JSON.parse(await readFile(filename, "utf8"));
      expect(persisted.env.EVM_PRIVATE_KEY).toBeUndefined();
      expect(persisted.env.SOLANA_PRIVATE_KEY).toBeUndefined();
    } finally {
      setAgentHostBridge(savedBridge);
      await server?.close();
      await testVault.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// Only the EVM key survived in the vault; the re-onboard must keep it and
// still provision the genuinely missing Solana key.
it("reuses the vault-held EVM key while provisioning the missing Solana key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallet-vault-partial-"));
  const savedBridge = getAgentHostBridge();
  const testVault = await createTestVault();
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
    }))
      vi.stubEnv(key, value);
    for (const key of [
      "ELIZA_WALLET_OS_STORE",
      "ELIZAOS_CLOUD_API_KEY",
      "STEWARD_API_URL",
      "EVM_PRIVATE_KEY",
      "SOLANA_PRIVATE_KEY",
      "SOLANA_PUBLIC_KEY",
      "WALLET_PUBLIC_KEY",
    ])
      vi.stubEnv(key, undefined);
    const priorEvm = generateWalletForChain("evm");
    await testVault.vault.set("EVM_PRIVATE_KEY", priorEvm.privateKey, {
      sensitive: true,
    });
    setAgentHostBridge({ ...savedBridge, sharedVault: () => testVault.vault });
    await writeFile(
      filename,
      JSON.stringify({ env: { ELIZA_WALLET_OS_STORE: "1" } }),
    );
    server = await startApiServer({
      port: 0,
      hostConfig: loadElizaConfig(),
      skipDeferredStartupWork: true,
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/wallet/keys`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { evmAddress: string };
    expect(body.evmAddress).toBe(priorEvm.address);
    expect(
      (await testVault.vault.reveal("EVM_PRIVATE_KEY")) === priorEvm.privateKey,
    ).toBe(true);
    expect(process.env.EVM_PRIVATE_KEY === priorEvm.privateKey).toBe(true);
    expect(process.env.SOLANA_PRIVATE_KEY).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(await testVault.vault.reveal("SOLANA_PRIVATE_KEY")).toBe(
      process.env.SOLANA_PRIVATE_KEY,
    );
  } finally {
    setAgentHostBridge(savedBridge);
    await server?.close();
    await testVault.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

// An unreadable vault must fail closed: provisioning over an unverifiable
// vault could destroy a stored wallet, so no key may be generated.
it("fails closed when the vault cannot be read before provisioning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wallet-vault-unreadable-"));
  const savedBridge = getAgentHostBridge();
  const testVault = await createTestVault();
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
    }))
      vi.stubEnv(key, value);
    for (const key of [
      "ELIZA_WALLET_OS_STORE",
      "ELIZAOS_CLOUD_API_KEY",
      "STEWARD_API_URL",
      "EVM_PRIVATE_KEY",
      "SOLANA_PRIVATE_KEY",
      "SOLANA_PUBLIC_KEY",
      "WALLET_PUBLIC_KEY",
    ])
      vi.stubEnv(key, undefined);
    const realVault = testVault.vault;
    const vault = new Proxy(realVault, {
      get(target, property) {
        if (property === "has")
          return async () => {
            throw new Error("vault unavailable");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setAgentHostBridge({ ...savedBridge, sharedVault: () => vault });
    await writeFile(
      filename,
      JSON.stringify({ env: { ELIZA_WALLET_OS_STORE: "1" } }),
    );
    server = await startApiServer({
      port: 0,
      hostConfig: loadElizaConfig(),
      skipDeferredStartupWork: true,
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/wallet/keys`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(500);
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(await realVault.has("EVM_PRIVATE_KEY")).toBe(false);
    expect(await realVault.has("SOLANA_PRIVATE_KEY")).toBe(false);
  } finally {
    setAgentHostBridge(savedBridge);
    await server?.close();
    await testVault.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
