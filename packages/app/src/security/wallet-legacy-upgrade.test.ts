import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import {
  _resetWalletEnvBootBaselineForTest,
  hydrateWalletKeysFromNodePlatformSecureStore,
} from "./hydrate-wallet-keys-from-platform-store";
import { deleteWalletSecrets } from "./wallet-secrets";

const legacy = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("./platform-secure-store-node", () => ({
  isWalletOsStoreReadEnabled: () => true,
  createNodePlatformSecureStore: () => ({
    isAvailable: async () => true,
    get: async (_vault: string, kind: string) => {
      const value = legacy.values.get(kind);
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    delete: async (_vault: string, kind: string) => ({
      ok: true,
      deleted: legacy.values.delete(kind),
    }),
  }),
}));
let vault: TestVault;
beforeEach(async () => {
  for (const key of [
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "STEWARD_API_URL",
    "STEWARD_TENANT_ID",
    "STEWARD_AGENT_ID",
    "STEWARD_API_KEY",
    "STEWARD_AGENT_TOKEN",
  ])
    vi.stubEnv(key, undefined);
  legacy.values.clear();
  _resetWalletEnvBootBaselineForTest();
  vault = await createTestVault();
  _resetSharedVaultForTesting(vault.vault);
  await vault.vault.has("EVM_PRIVATE_KEY");
}, 30_000);
afterEach(async () => {
  _resetSharedVaultForTesting();
  _resetWalletEnvBootBaselineForTest();
  await vault.dispose();
  vi.unstubAllEnvs();
});
it("recovers an existing OS-only wallet into the shared vault", async () => {
  legacy.values.set("wallet.evm_private_key", "legacy-fixture-key");
  await hydrateWalletKeysFromNodePlatformSecureStore();
  expect(process.env.EVM_PRIVATE_KEY).toBe("legacy-fixture-key");
  expect(await vault.vault.reveal("EVM_PRIVATE_KEY", "test")).toBe(
    "legacy-fixture-key",
  );
});
it("preserves a rotated vault key over the old OS copy", async () => {
  legacy.values.set("wallet.evm_private_key", "legacy-fixture-key");
  await vault.vault.set("EVM_PRIVATE_KEY", "rotated-fixture-key", {
    sensitive: true,
  });
  await hydrateWalletKeysFromNodePlatformSecureStore();
  expect(process.env.EVM_PRIVATE_KEY).toBe("rotated-fixture-key");
});
it("reset clears both copies so next boot cannot resurrect the wallet", async () => {
  legacy.values.set("wallet.evm_private_key", "legacy-fixture-key");
  legacy.values.set("wallet.solana_private_key", "legacy-solana-fixture");
  await vault.vault.set("EVM_PRIVATE_KEY", "vault-fixture-key", {
    sensitive: true,
  });
  await deleteWalletSecrets();
  expect(await vault.vault.has("EVM_PRIVATE_KEY")).toBe(false);
  expect(legacy.values.size).toBe(0);
  await hydrateWalletKeysFromNodePlatformSecureStore();
  expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
  expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
});
