/**
 * Registries barrel. BlockerRegistry, AnchorRegistry, EventKindRegistry,
 * FamilyRegistry. No cross-imports between siblings — each registry stands
 * alone.
 */

export {
  __resetBlockerRegistryForTests,
  createBlockerRegistry,
  getBlockerRegistry,
  registerBlockerRegistry,
} from "./blocker-registry.js";
export type {
  BlockerAvailability,
  BlockerContribution,
  BlockerKind,
  BlockerRegistry,
  BlockerStatusSummary,
} from "./blocker-registry.js";

export { appBlockerContribution } from "./app-blocker-contribution.js";
export {
  websiteBlockerContribution,
  type WebsiteBlockerStartResult,
} from "./website-blocker-contribution.js";

// Anchor / event-kind / family registries.
export {
  __resetAnchorRegistryForTests,
  APP_LIFEOPS_ANCHORS,
  type AnchorContext,
  type AnchorContribution,
  type AnchorRegistry,
  createAnchorRegistry,
  getAnchorRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
} from "./anchor-registry.js";
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
  createBlockerRegistry,
  registerBlockerRegistry,
  type BlockerRegistry,
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
