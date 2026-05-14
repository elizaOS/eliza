import { registerAppCoreRuntimeHooks } from "./runtime/app-core-runtime-hooks";
import { hydrateWalletKeysFromNodePlatformSecureStore } from "./security/hydrate-wallet-keys-from-platform-store";
import {
  applyAccountPoolApiCredentials,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
} from "./services/account-pool";
import { runVaultBootstrap } from "./services/vault-bootstrap";
import { sharedVault } from "./services/vault-mirror";
import type { AgentRuntime } from "@elizaos/core";

// Lazy wrapper: avoids static @elizaos/plugin-local-inference import at this boundary.
async function ensureLocalInferenceHandler(runtime: AgentRuntime): Promise<void> {
  const { ensureLocalInferenceHandler: _fn } = await import("@elizaos/plugin-local-inference/runtime");
  return _fn(runtime);
}

registerAppCoreRuntimeHooks({
  applyAccountPoolApiCredentials,
  ensureLocalInferenceHandler,
  getDefaultAccountPool,
  hydrateWalletKeysFromNodePlatformSecureStore,
  runVaultBootstrap,
  sharedVault,
  startAccountPoolKeepAlive,
});
