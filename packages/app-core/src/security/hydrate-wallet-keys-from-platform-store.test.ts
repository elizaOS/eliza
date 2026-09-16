/**
 * Behavioral coverage for boot-time wallet/steward env hydration. Drives the
 * real module against an in-process `createTestVault` (injected through
 * `_resetSharedVaultForTesting`) and isolated `process.env`. Vault fill,
 * launch-env precedence, the captured pre-merge baseline, whitespace gaps,
 * empty/single/both wallet keys, OS-store disable, and collaborator failures
 * are asserted from observed env and vault audit — not from mocks that echo
 * themselves. OS-store *copy* of a populated keychain is not seeded here:
 * writing the host Keychain would prompt and is outside this unit surface.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestVault, type TestVault, type Vault } from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import * as hydrateModule from "./hydrate-wallet-keys-from-platform-store.ts";
import {
  _resetWalletEnvBootBaselineForTest,
  captureWalletEnvBootBaseline,
  hydrateWalletKeysFromNodePlatformSecureStore,
} from "./hydrate-wallet-keys-from-platform-store.ts";

const WALLET_AND_STEWARD_KEYS = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
] as const;

const CONTROL_ENV_KEYS = [
  ...WALLET_AND_STEWARD_KEYS,
  "OPENROUTER_API_KEY",
  "ELIZA_WALLET_OS_STORE",
  "ELIZA_STATE_DIR",
] as const;

const EVM_VAULT =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOLANA_VAULT = "vault-solana-secret-not-a-real-key";
const EVM_LAUNCH =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVM_CONFIG =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

type EnvSnapshot = Record<
  (typeof CONTROL_ENV_KEYS)[number],
  string | undefined
>;

function snapshotEnv(): EnvSnapshot {
  const snapshot = {} as EnvSnapshot;
  for (const key of CONTROL_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of CONTROL_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearHandledEnv(): void {
  for (const key of WALLET_AND_STEWARD_KEYS) {
    delete process.env[key];
  }
}

function wrapVault(
  inner: Vault,
  overrides: { has?: Vault["has"]; reveal?: Vault["reveal"] },
): Vault {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "has" && overrides.has) return overrides.has;
      if (prop === "reveal" && overrides.reveal) return overrides.reveal;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });
}

describe("hydrate-wallet-keys-from-platform-store exports", () => {
  it("exposes baseline capture, the test reset, and the hydrate entry", () => {
    expect(Object.keys(hydrateModule).sort()).toEqual([
      "_resetWalletEnvBootBaselineForTest",
      "captureWalletEnvBootBaseline",
      "hydrateWalletKeysFromNodePlatformSecureStore",
    ]);
  });
});

describe("hydrateWalletKeysFromNodePlatformSecureStore", () => {
  let testVault: TestVault | undefined;
  let envSnapshot: EnvSnapshot;
  let stateDir: string | undefined;

  function openedVault(): TestVault {
    if (!testVault) {
      throw new Error("test vault was not created");
    }
    return testVault;
  }

  beforeEach(async () => {
    envSnapshot = snapshotEnv();
    clearHandledEnv();
    delete process.env.OPENROUTER_API_KEY;
    process.env.ELIZA_WALLET_OS_STORE = "0";
    stateDir = mkdtempSync(path.join(os.tmpdir(), "eliza-hydrate-wallet-"));
    process.env.ELIZA_STATE_DIR = stateDir;
    _resetWalletEnvBootBaselineForTest();
    testVault = await createTestVault();
    _resetSharedVaultForTesting(openedVault().vault);
  });

  afterEach(async () => {
    _resetWalletEnvBootBaselineForTest();
    _resetSharedVaultForTesting();
    restoreEnv(envSnapshot);
    if (testVault) await testVault.dispose();
    if (stateDir) rmSync(stateDir, { force: true, recursive: true });
  });

  it("leaves process.env empty when the vault is empty and OS-store reads are off", async () => {
    await hydrateWalletKeysFromNodePlatformSecureStore();

    for (const key of WALLET_AND_STEWARD_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it("fills a single missing wallet key from the vault and leaves the other unset", async () => {
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
  });

  it("fills both wallet keys from the vault", async () => {
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });
    await openedVault().vault.set("SOLANA_PRIVATE_KEY", SOLANA_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(SOLANA_VAULT);
  });

  it("records a reveal audit with caller wallet-hydrate-boot", async () => {
    await openedVault().vault.set("SOLANA_PRIVATE_KEY", SOLANA_VAULT, {
      sensitive: true,
    });
    await openedVault().clearAuditLog();

    await hydrateWalletKeysFromNodePlatformSecureStore();

    const reveals = (await openedVault().getAuditRecords()).filter(
      (record) => record.action === "reveal",
    );
    expect(reveals).toEqual([
      expect.objectContaining({
        action: "reveal",
        caller: "wallet-hydrate-boot",
        key: "SOLANA_PRIVATE_KEY",
      }),
    ]);
  });

  it("does not copy unrelated vault keys into process.env", async () => {
    await openedVault().vault.set("OPENROUTER_API_KEY", "sk-unrelated", {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
  });

  it("does not overwrite a present launch-env wallet key when no baseline is captured", async () => {
    process.env.EVM_PRIVATE_KEY = EVM_LAUNCH;
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_LAUNCH);
    const reveals = (await openedVault().getAuditRecords()).filter(
      (record) =>
        record.action === "reveal" && record.caller === "wallet-hydrate-boot",
    );
    expect(reveals).toEqual([]);
  });

  it("treats whitespace-only env as a gap and fills from the vault", async () => {
    process.env.EVM_PRIVATE_KEY = "   ";
    process.env.SOLANA_PRIVATE_KEY = "\t\n";
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });
    await openedVault().vault.set("SOLANA_PRIVATE_KEY", SOLANA_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(SOLANA_VAULT);
  });

  it("treats an empty-string env value as a gap", async () => {
    process.env.EVM_PRIVATE_KEY = "";
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
  });

  it("hydrates the missing wallet key while preserving the other launch-env value", async () => {
    process.env.EVM_PRIVATE_KEY = EVM_LAUNCH;
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });
    await openedVault().vault.set("SOLANA_PRIVATE_KEY", SOLANA_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_LAUNCH);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(SOLANA_VAULT);
  });

  it("lets vault overwrite a post-merge config value absent from the launch baseline", async () => {
    captureWalletEnvBootBaseline();
    process.env.EVM_PRIVATE_KEY = EVM_CONFIG;
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
  });

  it("protects a launch-env wallet key that was present when the baseline was captured", async () => {
    process.env.EVM_PRIVATE_KEY = EVM_LAUNCH;
    captureWalletEnvBootBaseline();
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_LAUNCH);
  });

  it("does not capture whitespace-only keys into the launch baseline", async () => {
    process.env.EVM_PRIVATE_KEY = "  ";
    captureWalletEnvBootBaseline();
    process.env.EVM_PRIVATE_KEY = EVM_CONFIG;
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
  });

  it("captures steward launch keys so a later post-merge value is still the launch one when OS-store is off", async () => {
    process.env.STEWARD_API_KEY = "launch-steward-key";
    captureWalletEnvBootBaseline();
    process.env.STEWARD_API_URL = "https://config.example/steward";

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.STEWARD_API_KEY).toBe("launch-steward-key");
    expect(process.env.STEWARD_API_URL).toBe("https://config.example/steward");
  });

  it("restores pre-merge semantics after the test-only baseline reset", async () => {
    captureWalletEnvBootBaseline();
    process.env.EVM_PRIVATE_KEY = EVM_CONFIG;
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    _resetWalletEnvBootBaselineForTest();
    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_CONFIG);
  });

  it("fills from the vault after reset when the current env value is blank", async () => {
    process.env.EVM_PRIVATE_KEY = EVM_LAUNCH;
    captureWalletEnvBootBaseline();
    delete process.env.EVM_PRIVATE_KEY;
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
  });

  it("is idempotent: a second hydrate does not change already-filled env", async () => {
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });
    await hydrateWalletKeysFromNodePlatformSecureStore();
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_CONFIG, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.EVM_PRIVATE_KEY).toBe(EVM_VAULT);
  });

  it("does not invent steward env values when OS-store reads are disabled", async () => {
    process.env.ELIZA_WALLET_OS_STORE = "0";

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.STEWARD_API_URL).toBeUndefined();
    expect(process.env.STEWARD_TENANT_ID).toBeUndefined();
    expect(process.env.STEWARD_AGENT_ID).toBeUndefined();
    expect(process.env.STEWARD_API_KEY).toBeUndefined();
    expect(process.env.STEWARD_AGENT_TOKEN).toBeUndefined();
  });

  it("preserves steward launch-env values while filling a wallet key from the vault", async () => {
    process.env.STEWARD_API_URL = "https://launch.example/steward";
    process.env.STEWARD_API_KEY = "launch-api-key";
    await openedVault().vault.set("SOLANA_PRIVATE_KEY", SOLANA_VAULT, {
      sensitive: true,
    });

    await hydrateWalletKeysFromNodePlatformSecureStore();

    expect(process.env.SOLANA_PRIVATE_KEY).toBe(SOLANA_VAULT);
    expect(process.env.STEWARD_API_URL).toBe("https://launch.example/steward");
    expect(process.env.STEWARD_API_KEY).toBe("launch-api-key");
  });

  it("rejects when vault.has throws before any env write", async () => {
    _resetSharedVaultForTesting(
      wrapVault(openedVault().vault, {
        has: async () => {
          throw new Error("vault has failed");
        },
      }),
    );

    await expect(
      hydrateWalletKeysFromNodePlatformSecureStore(),
    ).rejects.toThrow("vault has failed");
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
  });

  it("rejects when vault.reveal throws after has reports the key present", async () => {
    await openedVault().vault.set("EVM_PRIVATE_KEY", EVM_VAULT, {
      sensitive: true,
    });
    _resetSharedVaultForTesting(
      wrapVault(openedVault().vault, {
        reveal: async () => {
          throw new Error("vault reveal failed");
        },
      }),
    );

    await expect(
      hydrateWalletKeysFromNodePlatformSecureStore(),
    ).rejects.toThrow("vault reveal failed");
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
  });
});
