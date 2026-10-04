import { sharedVault } from "../services/vault-mirror";

export async function deleteWalletSecrets(): Promise<void> {
  const vault = sharedVault();
  for (const key of ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"]) {
    if (await vault.has(key)) await vault.remove(key);
  }
}
