/**
 * Hydration of EVM_PRIVATE_KEY / SOLANA_PRIVATE_KEY from the shared
 * vault. The legacy OS-keystore one-shot fallback is exercised through
 * the migration helper; this test focuses on the vault-first read path
 * since it's now the source of truth.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createVault,
  generateMasterKey,
  inMemoryMasterKey,
  type Vault,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig: vi.fn(() => undefined),
}));

import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import { hydrateWalletKeysFromNodePlatformSecureStore } from "./hydrate-wallet-keys-from-platform-store";

describe("hydrate-wallet-keys-from-platform-store", () => {
  let workDir: string;
  let vault: Vault;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-wallet-hydrate-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    _resetSharedVaultForTesting(vault);
    for (const k of [
      "EVM_PRIVATE_KEY",
      "SOLANA_PRIVATE_KEY",
      "ELIZA_WALLET_OS_STORE",
    ]) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
    _resetSharedVaultForTesting(null);
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("populates process.env wallet keys from the vault when env is empty", async () => {
    await vault.set("EVM_PRIVATE_KEY", "0xVAULTED", { sensitive: true });
    await vault.set("SOLANA_PRIVATE_KEY", "solVAULTED", { sensitive: true });
    await hydrateWalletKeysFromNodePlatformSecureStore();
    expect(process.env.EVM_PRIVATE_KEY).toBe("0xVAULTED");
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("solVAULTED");
  });

  it("does not clobber a non-empty env value with a vault read", async () => {
    process.env.EVM_PRIVATE_KEY = "0xFROMENV";
    await vault.set("EVM_PRIVATE_KEY", "0xVAULT", { sensitive: true });
    await hydrateWalletKeysFromNodePlatformSecureStore();
    expect(process.env.EVM_PRIVATE_KEY).toBe("0xFROMENV");
  });

  it("leaves process.env untouched when neither env nor vault has a value", async () => {
    await hydrateWalletKeysFromNodePlatformSecureStore();
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
  });
});
