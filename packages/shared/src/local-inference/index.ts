/**
 * @elizaos/shared/local-inference
 *
 * Shared local-inference contract used by both the server-side service
 * (`@elizaos/app-core/src/services/local-inference`) and the UI client
 * (`@elizaos/ui/src/services/local-inference`). Only modules that are
 * byte-identical between the two and that share the exact same semantics
 * live here. Server-only logic (KV cache management, llama-server
 * lifecycle, conversation registry, metrics scraping) stays in
 * `app-core`.
 */

export {
  buildHuggingFaceResolveUrl,
  buildHuggingFaceResolveUrlForPath,
  DEFAULT_ELIGIBLE_MODEL_IDS,
  ELIZA_1_PLACEHOLDER_IDS,
  ELIZA_1_TIER_IDS,
  type Eliza1TierId,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  isDefaultEligibleId,
  MODEL_CATALOG,
} from "./catalog.js";
export {
  downloadsStagingDir,
  elizaModelsDir,
  isWithinElizaRoot,
  localInferenceRoot,
  registryPath,
} from "./paths.js";
export {
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
  type RoutingPreferences,
  readRoutingPreferences,
  setPolicy,
  setPreferredProvider,
  writeRoutingPreferences,
} from "./routing-preferences.js";
export {
  AGENT_MODEL_SLOTS,
  type AgentModelSlot,
  type InstalledModel,
  type ModelAssignments,
  type TextGenerationSlot,
} from "./types.js";
export {
  __registryPathForTests,
  hashFile,
  type VerifyResult,
  type VerifyState,
  verifyInstalledModel,
} from "./verify.js";
