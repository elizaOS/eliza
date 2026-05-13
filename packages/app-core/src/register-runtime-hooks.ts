import { registerAppCoreRuntimeHooks } from "./runtime/app-core-runtime-hooks";
import { ensureLocalInferenceHandler } from "./runtime/ensure-local-inference-handler";
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
  ensureLocalInferenceHandler,
  getDefaultAccountPool,
  hydrateWalletKeysFromNodePlatformSecureStore,
  runVaultBootstrap,
  sharedVault,
  startAccountPoolKeepAlive,
});
