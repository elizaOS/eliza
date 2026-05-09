/**
 * W2-F — Registries barrel.
 *
 * Wave 2 lands the BlockerRegistry; W2-D lands AnchorRegistry,
 * EventKindRegistry, FamilyRegistry in this same directory. No cross-imports
 * between siblings — each registry stands alone.
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

// W2-D — anchor / event-kind / family registries.
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
