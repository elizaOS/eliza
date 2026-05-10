import { registerAppCoreRuntimeHooks } from "@elizaos/core";
import { hydrateWalletKeysFromNodePlatformSecureStore } from "./security/hydrate-wallet-keys-from-platform-store";
import {
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
} from "./services/account-pool";
import { runVaultBootstrap } from "./services/vault-bootstrap";
import { sharedVault } from "./services/vault-mirror";

registerAppCoreRuntimeHooks({
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  hydrateWalletKeysFromNodePlatformSecureStore,
  runVaultBootstrap,
  sharedVault,
  startAccountPoolKeepAlive,
});
