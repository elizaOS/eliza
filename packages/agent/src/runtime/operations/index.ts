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
} from "./classifier.js";
export type { ColdStrategyOptions } from "./cold-strategy.js";
export { createColdStrategy } from "./cold-strategy.js";
export { getDefaultHealthChecker, HealthChecker } from "./health.js";
export {
  builtInHealthChecks,
  dbConnectionCheck,
  essentialServicesCheck,
  providerSmokeCheck,
  runtimeReadyCheck,
} from "./health-checks.js";
export {
  DefaultRuntimeOperationManager,
  type DefaultRuntimeOperationManagerOptions,
  type IntentClassifier,
} from "./manager.js";
export { createHotStrategy, type HotStrategyDeps } from "./reload-hot.js";
export {
  FilesystemRuntimeOperationRepository,
  getDefaultRepository,
} from "./repository.js";
export * from "./types.js";
export {
  defaultSecretsManager,
  persistProviderApiKey,
  resolveProviderApiKey,
  vaultKeyForProviderApiKey,
  _resetDefaultSecretsManagerForTesting,
} from "./vault-bridge.js";
