/**
 * RuntimeOperation public surface.
 *
 * Implementations are sibling files; this barrel keeps consumers off the
 * individual paths.
 */

export {
  classifyOperation,
  defaultClassifier,
  type ClassifyContext,
} from "./classifier.js";
export { createColdStrategy } from "./cold-strategy.js";
export type { ColdStrategyOptions } from "./cold-strategy.js";
export { createHotStrategy, type HotStrategyDeps } from "./reload-hot.js";
export { HealthChecker, getDefaultHealthChecker } from "./health.js";
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
export {
  FilesystemRuntimeOperationRepository,
  getDefaultRepository,
} from "./repository.js";
export * from "./types.js";
