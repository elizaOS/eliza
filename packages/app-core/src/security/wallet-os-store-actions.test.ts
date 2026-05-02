/**
 * wallet-os-store-actions — vault unification tests.
 *
 * Verifies the post-unification storage layout:
 *   - migrate writes the env-shaped key into the shared vault (sensitive)
 *   - migrate is idempotent (second call is a no-op when vault already has it)
 *   - delete clears the vault entry (and OS-keystore cleanup is best-effort)
 *   - the listed inventory categorizes the key as "wallet" without explicit meta
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createVault,
  generateMasterKey,
  inMemoryMasterKey,
  listVaultInventory,
  type Vault,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub `loadElizaConfig` / `saveElizaConfig` so the tests don't touch
// the real eliza state dir. The agent module is large; mock just the
// two functions we use.
vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: vi.fn(() => ({ env: {} as Record<string, unknown> })),
  saveElizaConfig: vi.fn(() => undefined),
}));

import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import {
  deleteWalletSecretsFromOsStore,
  migrateWalletPrivateKeysToOsStore,
} from "./wallet-os-store-actions";

describe("wallet-os-store-actions (vault-unified)", () => {
  let workDir: string;
  let vault: Vault;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-wallet-store-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    _resetSharedVaultForTesting(vault);
    // Capture and clear the wallet env vars so tests start from a known
    // state.
    for (const k of ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"]) {
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

  it("migrate writes EVM_PRIVATE_KEY into the vault (sensitive)", async () => {
    process.env.EVM_PRIVATE_KEY = "0xMIGRATEME";
    const result = await migrateWalletPrivateKeysToOsStore();
    expect(result.failed).toEqual([]);
    expect(result.migrated).toEqual(["EVM_PRIVATE_KEY"]);
    expect(await vault.has("EVM_PRIVATE_KEY")).toBe(true);
    const desc = await vault.describe("EVM_PRIVATE_KEY");
    expect(desc?.sensitive).toBe(true);
  });

  it("migrate is idempotent when the vault already holds the key", async () => {
    await vault.set("EVM_PRIVATE_KEY", "0xALREADYTHERE", { sensitive: true });
    process.env.EVM_PRIVATE_KEY = "0xWOULDOVERWRITE";
    const result = await migrateWalletPrivateKeysToOsStore();
    expect(result.migrated).toEqual([]);
    // Vault entry must NOT be replaced — rotation safety.
    const value = await vault.reveal("EVM_PRIVATE_KEY", "test");
    expect(value).toBe("0xALREADYTHERE");
  });

  it("inventory surfaces EVM_PRIVATE_KEY under the wallet category by default", async () => {
    process.env.EVM_PRIVATE_KEY = "0xINVCHECK";
    process.env.SOLANA_PRIVATE_KEY = "solanaINV";
    await migrateWalletPrivateKeysToOsStore();
    const entries = await listVaultInventory(vault);
    const evm = entries.find((e) => e.key === "EVM_PRIVATE_KEY");
    const sol = entries.find((e) => e.key === "SOLANA_PRIVATE_KEY");
    expect(evm?.category).toBe("wallet");
    expect(sol?.category).toBe("wallet");
  });

  it("delete removes the vault entry", async () => {
    await vault.set("EVM_PRIVATE_KEY", "0xDELETEME", { sensitive: true });
    await vault.set("SOLANA_PRIVATE_KEY", "solDELETEME", { sensitive: true });
    expect(await vault.has("EVM_PRIVATE_KEY")).toBe(true);
    expect(await vault.has("SOLANA_PRIVATE_KEY")).toBe(true);
    await deleteWalletSecretsFromOsStore();
    expect(await vault.has("EVM_PRIVATE_KEY")).toBe(false);
    expect(await vault.has("SOLANA_PRIVATE_KEY")).toBe(false);
  });
});
