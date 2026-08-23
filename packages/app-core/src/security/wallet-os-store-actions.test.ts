/**
 * Unit coverage for wallet-os-store-actions: agent-reset deletion of vault and
 * legacy OS-keystore wallet slots, and the one-shot env/config → vault
 * migration. Drives the real module against createTestVault; the OS keystore
 * is a Map-backed collaborator so tests never touch Keychain/libsecret, and
 * loadElizaConfig/saveElizaConfig are recorded so config stripping is asserted
 * from the payload the module writes.
 */
import {
  createTestVault,
  type SetOptions,
  type TestVault,
  type Vault,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import type {
  SecureStoreDeleteResult,
  SecureStoreSecretKind,
} from "./platform-secure-store";
import {
  deleteWalletSecretsFromOsStore,
  migrateWalletPrivateKeysToOsStore,
} from "./wallet-os-store-actions";

const ENV_KEYS = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "ELIZA_WALLET_OS_STORE",
  "ELIZA_STATE_DIR",
] as const;

const osStore = vi.hoisted(() => {
  const deleteCalls: Array<{
    vaultId: string;
    kind: SecureStoreSecretKind;
  }> = [];
  return {
    available: true,
    createCount: 0,
    deleteCalls,
    nextDelete: async (
      _vaultId: string,
      _kind: SecureStoreSecretKind,
    ): Promise<SecureStoreDeleteResult> => ({ ok: true, deleted: true }),
    reset() {
      this.available = true;
      this.createCount = 0;
      this.deleteCalls.length = 0;
      this.nextDelete = async () => ({ ok: true, deleted: true });
    },
  };
});

const configHarness = vi.hoisted(() => {
  let config: { env?: unknown } = {};
  const saves: Array<{ env?: unknown }> = [];
  return {
    load: () => config,
    save: (next: { env?: unknown }) => {
      saves.push(structuredClone(next));
      config = next;
    },
    saves,
    reset(next: { env?: unknown } = {}) {
      config = next;
      saves.length = 0;
    },
  };
});

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => configHarness.load(),
  saveElizaConfig: (next: { env?: unknown }) => {
    configHarness.save(next);
  },
}));

vi.mock("./platform-secure-store-node", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./platform-secure-store-node")>();
  return {
    ...actual,
    createNodePlatformSecureStore: () => {
      osStore.createCount += 1;
      return {
        backend: "none" as const,
        get: async () => ({ ok: false as const, reason: "not_found" as const }),
        set: async () => ({ ok: true as const }),
        delete: async (
          vaultId: string,
          kind: SecureStoreSecretKind,
        ): Promise<SecureStoreDeleteResult> => {
          osStore.deleteCalls.push({ vaultId, kind });
          return osStore.nextDelete(vaultId, kind);
        },
        isAvailable: async () => osStore.available,
      };
    },
  };
});

const savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  EVM_PRIVATE_KEY: undefined,
  SOLANA_PRIVATE_KEY: undefined,
  ELIZA_WALLET_OS_STORE: undefined,
  ELIZA_STATE_DIR: undefined,
};

let testVault: TestVault | undefined;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function vaultWithSetFault(
  inner: Vault,
  failKey: string,
  error: unknown,
): Vault {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "set") {
        return async (key: string, value: string, opts?: SetOptions) => {
          if (key === failKey) throw error;
          return target.set(key, value, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });
}

async function installVault(
  opts?: Parameters<typeof createTestVault>[0],
  wrap?: (vault: Vault) => Vault,
): Promise<Vault> {
  testVault = await createTestVault(opts);
  const vault = wrap ? wrap(testVault.vault) : testVault.vault;
  _resetSharedVaultForTesting(vault);
  return vault;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ELIZA_STATE_DIR = "/tmp/eliza-wallet-os-store-actions-test";
  osStore.reset();
  configHarness.reset();
});

afterEach(async () => {
  _resetSharedVaultForTesting();
  if (testVault) {
    await testVault.dispose();
    testVault = undefined;
  }
  restoreEnv();
});

describe("deleteWalletSecretsFromOsStore", () => {
  it("removes present vault keys and leaves missing slots untouched", async () => {
    const vault = await installVault({
      secrets: { EVM_PRIVATE_KEY: "0xpresent" },
    });
    process.env.ELIZA_WALLET_OS_STORE = "0";

    await deleteWalletSecretsFromOsStore();

    expect(await vault.has("EVM_PRIVATE_KEY")).toBe(false);
    expect(await vault.has("SOLANA_PRIVATE_KEY")).toBe(false);
    expect(osStore.createCount).toBe(0);
  });

  it("does not open the OS keystore when the read path is disabled", async () => {
    await installVault({
      secrets: {
        EVM_PRIVATE_KEY: "0xevm",
        SOLANA_PRIVATE_KEY: "solana-secret",
      },
    });
    process.env.ELIZA_WALLET_OS_STORE = "false";

    await deleteWalletSecretsFromOsStore();

    expect(osStore.createCount).toBe(0);
    expect(osStore.deleteCalls).toEqual([]);
  });

  it("skips OS deletion when the keystore reports unavailable", async () => {
    await installVault();
    process.env.ELIZA_WALLET_OS_STORE = "1";
    osStore.available = false;

    await deleteWalletSecretsFromOsStore();

    expect(osStore.createCount).toBe(1);
    expect(osStore.deleteCalls).toEqual([]);
  });

  it("deletes both OS kinds under the derived vault id, EVM then Solana", async () => {
    await installVault();
    process.env.ELIZA_WALLET_OS_STORE = "yes";

    await deleteWalletSecretsFromOsStore();

    const vaultId = deriveAgentVaultId();
    expect(osStore.deleteCalls).toEqual([
      { vaultId, kind: "wallet.evm_private_key" },
      { vaultId, kind: "wallet.solana_private_key" },
    ]);
  });

  it("treats an already-missing OS secret as success", async () => {
    await installVault();
    process.env.ELIZA_WALLET_OS_STORE = "1";
    osStore.nextDelete = async () => ({ ok: true, deleted: false });

    await expect(deleteWalletSecretsFromOsStore()).resolves.toBeUndefined();
    expect(osStore.deleteCalls).toHaveLength(2);
  });

  it("throws the store reason and stops after the first rejected OS delete", async () => {
    await installVault();
    process.env.ELIZA_WALLET_OS_STORE = "1";
    osStore.nextDelete = async (_vaultId, kind) => {
      if (kind === "wallet.evm_private_key") {
        return { ok: false, reason: "denied" };
      }
      return { ok: true, deleted: true };
    };

    await expect(deleteWalletSecretsFromOsStore()).rejects.toThrow(
      "OS credential store rejected wallet deletion: denied",
    );
    expect(osStore.deleteCalls.map((call) => call.kind)).toEqual([
      "wallet.evm_private_key",
    ]);
  });

  it("still attempts OS cleanup when the vault is empty", async () => {
    await installVault();
    process.env.ELIZA_WALLET_OS_STORE = "on";

    await deleteWalletSecretsFromOsStore();

    expect(osStore.deleteCalls).toHaveLength(2);
  });
});

describe("migrateWalletPrivateKeysToOsStore", () => {
  it("migrates nothing when env and config are empty", async () => {
    const vault = await installVault();

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result).toEqual({ migrated: [], failed: [] });
    expect(configHarness.saves).toEqual([]);
    expect(await vault.list()).toEqual([]);
  });

  it("writes a process-env EVM key to the vault without rewriting env or config", async () => {
    const vault = await installVault();
    process.env.EVM_PRIVATE_KEY = "  0xspaced  ";

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result).toEqual({
      migrated: ["EVM_PRIVATE_KEY"],
      failed: [],
    });
    expect(await vault.get("EVM_PRIVATE_KEY")).toBe("0xspaced");
    expect(process.env.EVM_PRIVATE_KEY).toBe("  0xspaced  ");
    expect(configHarness.saves).toEqual([]);
  });

  it("copies a config-only Solana key into the vault, hydrates process.env, and deletes empty env", async () => {
    const vault = await installVault();
    configHarness.reset({
      env: { SOLANA_PRIVATE_KEY: "  sol-from-config  " },
    });

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result).toEqual({
      migrated: ["SOLANA_PRIVATE_KEY"],
      failed: [],
    });
    expect(await vault.get("SOLANA_PRIVATE_KEY")).toBe("sol-from-config");
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("sol-from-config");
    expect(configHarness.saves).toHaveLength(1);
    expect(configHarness.saves[0]?.env).toBeUndefined();
  });

  it("strips wallet keys from config.env while keeping sibling entries", async () => {
    await installVault();
    configHarness.reset({
      env: {
        EVM_PRIVATE_KEY: "0xcfg",
        OPENROUTER_API_KEY: "sk-keep",
      },
    });

    await migrateWalletPrivateKeysToOsStore();

    expect(configHarness.saves).toHaveLength(1);
    expect(configHarness.saves[0]?.env).toEqual({
      OPENROUTER_API_KEY: "sk-keep",
    });
  });

  it("prefers process.env over a config value for the same key", async () => {
    const vault = await installVault();
    process.env.EVM_PRIVATE_KEY = "0xfrom-process";
    configHarness.reset({ env: { EVM_PRIVATE_KEY: "0xfrom-config" } });

    await migrateWalletPrivateKeysToOsStore();

    expect(await vault.get("EVM_PRIVATE_KEY")).toBe("0xfrom-process");
  });

  it("does not overwrite a vault value that may have been rotated", async () => {
    const vault = await installVault({
      secrets: { EVM_PRIVATE_KEY: "0xalready-rotated" },
    });
    process.env.EVM_PRIVATE_KEY = "0xshould-not-win";

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result).toEqual({ migrated: [], failed: [] });
    expect(await vault.get("EVM_PRIVATE_KEY")).toBe("0xalready-rotated");
  });

  it("falls through whitespace-only process env to the config value", async () => {
    const vault = await installVault();
    process.env.EVM_PRIVATE_KEY = "   ";
    configHarness.reset({ env: { EVM_PRIVATE_KEY: "0xfrom-config" } });

    await migrateWalletPrivateKeysToOsStore();

    expect(await vault.get("EVM_PRIVATE_KEY")).toBe("0xfrom-config");
    expect(process.env.EVM_PRIVATE_KEY).toBe("0xfrom-config");
  });

  it("treats an array config.env as empty persisted env", async () => {
    const vault = await installVault();
    configHarness.reset({ env: ["EVM_PRIVATE_KEY"] });

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result).toEqual({ migrated: [], failed: [] });
    expect(await vault.list()).toEqual([]);
    expect(configHarness.saves).toEqual([]);
  });

  it("does not strip a non-string wallet slot from config.env", async () => {
    await installVault();
    configHarness.reset({
      env: { EVM_PRIVATE_KEY: { nested: true }, KEEP: "yes" },
    });

    await migrateWalletPrivateKeysToOsStore();

    expect(configHarness.saves).toEqual([]);
  });

  it("strips an empty-string wallet key from config even when nothing is migrated", async () => {
    await installVault();
    configHarness.reset({
      env: { EVM_PRIVATE_KEY: "", KEEP: "yes" },
    });

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result).toEqual({ migrated: [], failed: [] });
    expect(configHarness.saves[0]?.env).toEqual({ KEEP: "yes" });
  });

  it("migrates both keys in WALLET_PAIRS order", async () => {
    const vault = await installVault();
    process.env.EVM_PRIVATE_KEY = "0xevm";
    process.env.SOLANA_PRIVATE_KEY = "sol";

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result.migrated).toEqual(["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"]);
    expect(await vault.get("EVM_PRIVATE_KEY")).toBe("0xevm");
    expect(await vault.get("SOLANA_PRIVATE_KEY")).toBe("sol");
  });

  it("rethrows a vault Error, keeps the earlier write, and does not save config", async () => {
    const vault = await installVault(undefined, (inner) =>
      vaultWithSetFault(inner, "SOLANA_PRIVATE_KEY", new Error("disk full")),
    );
    process.env.EVM_PRIVATE_KEY = "0xevm";
    process.env.SOLANA_PRIVATE_KEY = "sol";
    configHarness.reset({ env: { SOLANA_PRIVATE_KEY: "sol" } });

    await expect(migrateWalletPrivateKeysToOsStore()).rejects.toThrow(
      "disk full",
    );
    expect(await vault.get("EVM_PRIVATE_KEY")).toBe("0xevm");
    expect(await vault.has("SOLANA_PRIVATE_KEY")).toBe(false);
    expect(configHarness.saves).toEqual([]);
  });

  it("wraps a non-Error vault throw after recording the failed key", async () => {
    await installVault(undefined, (inner) =>
      vaultWithSetFault(inner, "EVM_PRIVATE_KEY", "nope"),
    );
    process.env.EVM_PRIVATE_KEY = "0xevm";

    await expect(migrateWalletPrivateKeysToOsStore()).rejects.toThrow(
      "vault write failed for EVM_PRIVATE_KEY: nope",
    );
  });

  it("is idempotent: a second run migrates nothing", async () => {
    await installVault();
    process.env.EVM_PRIVATE_KEY = "0xevm";

    expect(await migrateWalletPrivateKeysToOsStore()).toEqual({
      migrated: ["EVM_PRIVATE_KEY"],
      failed: [],
    });
    expect(await migrateWalletPrivateKeysToOsStore()).toEqual({
      migrated: [],
      failed: [],
    });
  });

  it("writes vault entries as sensitive with caller wallet-migrate", async () => {
    const vault = await installVault();
    process.env.EVM_PRIVATE_KEY = "0xevm";

    await migrateWalletPrivateKeysToOsStore();

    expect(await vault.describe("EVM_PRIVATE_KEY")).toMatchObject({
      key: "EVM_PRIVATE_KEY",
      sensitive: true,
    });
    const audit = testVault ? await testVault.getAuditRecords() : [];
    expect(audit.some((record) => record.caller === "wallet-migrate")).toBe(
      true,
    );
  });

  it("still strips config.env when the vault already holds the key", async () => {
    await installVault({ secrets: { EVM_PRIVATE_KEY: "0xkept" } });
    configHarness.reset({ env: { EVM_PRIVATE_KEY: "0xstale-config" } });

    const result = await migrateWalletPrivateKeysToOsStore();

    expect(result).toEqual({ migrated: [], failed: [] });
    expect(configHarness.saves).toHaveLength(1);
    expect(configHarness.saves[0]?.env).toBeUndefined();
  });
});
