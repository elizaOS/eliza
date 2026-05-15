/**
 * Registries barrel. BlockerRegistry, AnchorRegistry, EventKindRegistry,
 * FamilyRegistry, WorkflowStepRegistry, FeatureFlagRegistry. No cross-imports
 * between siblings — each registry stands alone.
 */

// Anchor / event-kind / family registries.
export {
  __resetAnchorRegistryForTests,
  type AnchorContext,
  type AnchorContribution,
  type AnchorRegistry,
  APP_LIFEOPS_ANCHORS,
  createAnchorRegistry,
  getAnchorRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
} from "./anchor-registry.js";
export { appBlockerContribution } from "./app-blocker-contribution.js";
export type {
  BlockerAvailability,
  BlockerContribution,
  BlockerKind,
  BlockerRegistry,
  BlockerStatusSummary,
} from "./blocker-registry.js";
export {
  __resetBlockerRegistryForTests,
  createBlockerRegistry,
  getBlockerRegistry,
  registerBlockerRegistry,
} from "./blocker-registry.js";
export {
  __resetEventKindRegistryForTests,
  APP_LIFEOPS_EVENT_KINDS,
  createEventKindRegistry,
  type EventKindContribution,
  type EventKindRegistry,
  getEventKindRegistry,
  registerAppLifeOpsEventKinds,
  registerEventKindRegistry,
} from "./event-kind-registry.js";
export {
  __resetFamilyRegistryForTests,
  APP_LIFEOPS_BUS_FAMILIES,
  type BusFamilyContribution,
  createFamilyRegistry,
  type FamilyRegistry,
  getFamilyRegistry,
  registerAppLifeOpsBusFamilies,
  registerBuiltinTelemetryFamilies,
  registerFamilyRegistry,
} from "./family-registry.js";
export {
  DEFAULT_FEATURE_FLAG_PACK,
  LIFEOPS_BUILTIN_FEATURE_KEYS,
  registerDefaultFeatureFlagPack,
} from "./feature-flag-default-pack.js";
export {
  __resetFeatureFlagRegistryForTests,
  createFeatureFlagRegistry,
  type FeatureFlagContribution,
  type FeatureFlagRegistry,
  getFeatureFlagRegistry,
  registerFeatureFlagRegistry,
  UnknownFeatureFlagError,
} from "./feature-flag-registry.js";
export {
  type WebsiteBlockerStartResult,
  websiteBlockerContribution,
} from "./website-blocker-contribution.js";
export {
  APP_LIFEOPS_WORKFLOW_STEP_CONTRIBUTIONS,
  registerDefaultWorkflowStepPack,
} from "./workflow-step-default-pack.js";
export {
  __resetWorkflowStepRegistryForTests,
  type AnyWorkflowStepContribution,
  createWorkflowStepRegistry,
  getWorkflowStepRegistry,
  registerWorkflowStepRegistry,
  UnknownWorkflowStepError,
  type WorkflowStepContribution,
  type WorkflowStepExecuteArgs,
  type WorkflowStepExecuteContext,
  type WorkflowStepRegistry,
} from "./workflow-step-registry.js";

import type { IAgentRuntime } from "@elizaos/core";
import { appBlockerContribution } from "./app-blocker-contribution.js";
import {
  type BlockerRegistry,
  createBlockerRegistry,
  registerBlockerRegistry,
} from "./blocker-registry.js";
import { websiteBlockerContribution } from "./website-blocker-contribution.js";

/**
 * Create a registry, register the two built-in enforcers (website + app),
 * and bind it to the runtime. Plugin `init` calls this once during bootstrap.
 */
export function registerDefaultBlockerPack(
  runtime: IAgentRuntime,
): BlockerRegistry {
  const registry = createBlockerRegistry();
  registry.register(websiteBlockerContribution);
  registry.register(appBlockerContribution);
  registerBlockerRegistry(runtime, registry);
  return registry;
}
