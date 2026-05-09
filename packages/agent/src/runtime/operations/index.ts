/**
 * RuntimeOperation public surface.
 *
 * Implementations are sibling files; this barrel keeps consumers off the
 * individual paths.
 */

export {
  type ClassifyContext,
  classifyOperation,
  defaultClassifier,
} from "./classifier.ts";
export type { ColdStrategyOptions } from "./cold-strategy.ts";
export { createColdStrategy } from "./cold-strategy.ts";
export { getDefaultHealthChecker, HealthChecker } from "./health.ts";
export {
  builtInHealthChecks,
  dbConnectionCheck,
  essentialServicesCheck,
  providerSmokeCheck,
  runtimeReadyCheck,
} from "./health-checks.ts";
export {
  DefaultRuntimeOperationManager,
  type DefaultRuntimeOperationManagerOptions,
  type IntentClassifier,
} from "./manager.ts";
export { createHotStrategy, type HotStrategyDeps } from "./reload-hot.ts";
export {
  FilesystemRuntimeOperationRepository,
  getDefaultRepository,
} from "./repository.ts";
export * from "./types.ts";
export {
  _resetDefaultSecretsManagerForTesting,
  defaultSecretsManager,
  formatVaultRef,
  isVaultRef,
  parseVaultRef,
  persistProviderApiKey,
  resolveConfigEnvForProcess,
  resolveProviderApiKey,
  type VaultLike,
  vaultKeyForProviderApiKey,
} from "./vault-bridge.ts";
