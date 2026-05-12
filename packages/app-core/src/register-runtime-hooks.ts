import { registerAppCoreRuntimeHooks } from "./runtime/app-core-runtime-hooks";
import { hydrateWalletKeysFromNodePlatformSecureStore } from "./security/hydrate-wallet-keys-from-platform-store";
import {
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
} from "./services/account-pool";
import { runVaultBootstrap } from "./services/vault-bootstrap";
import { sharedVault } from "./services/vault-mirror";
import { ensureLocalInferenceHandler } from "./runtime/ensure-local-inference-handler";

registerAppCoreRuntimeHooks({
  applyAccountPoolApiCredentials,
  ensureLocalInferenceHandler,
  getDefaultAccountPool,
  hydrateWalletKeysFromNodePlatformSecureStore,
  runVaultBootstrap,
  sharedVault,
  startAccountPoolKeepAlive,
});
