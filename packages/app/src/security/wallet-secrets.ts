import { sharedVault } from "../services/vault-mirror";
import { deriveAgentVaultId } from "./agent-vault-id";
import {
  createNodePlatformSecureStore,
  isWalletOsStoreReadEnabled,
} from "./platform-secure-store-node";

export async function deleteWalletSecrets(): Promise<void> {
  const vault = sharedVault();
  for (const key of ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"]) {
    if (await vault.has(key)) await vault.remove(key);
  }
  // Clear the old copy as well; otherwise next boot can migrate it back.
  if (!isWalletOsStoreReadEnabled()) return;
  const store = createNodePlatformSecureStore();
  if (!(await store.isAvailable())) return;
  const vaultId = deriveAgentVaultId();
  for (const kind of [
    "wallet.evm_private_key",
    "wallet.solana_private_key",
  ] as const) {
    const result = await store.delete(vaultId, kind);
    if (!result.ok)
      throw new Error(
        `OS credential store rejected wallet deletion: ${result.reason}`,
      );
  }
}
