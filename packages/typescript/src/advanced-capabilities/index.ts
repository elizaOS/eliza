/**
 * Advanced Capabilities
 *
 * Extended functionality that can be enabled with `enableExtendedCapabilities: true`
 * or `advancedCapabilities: true` in plugin initialization.
 *
 * These provide additional agent features:
 * - Extended providers (facts, contacts, relationships, roles, settings, knowledge)
 * - Advanced actions (contacts management, room management, image generation, etc.)
 * - Evaluators (reflection, relationship extraction, experience learning)
 * - Additional services (experience memory)
 */

import { withCanonicalActionDocs } from "../action-docs.ts";
import type { IAgentRuntime } from "../types/index.ts";
import type { ServiceClass } from "../types/plugin.ts";
import {
	experienceEvaluator,
	experienceProvider,
	recordExperienceAction,
} from "./experience/index.ts";

// Re-export action, provider, and evaluator modules
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./providers/index.ts";
export * from "./experience/index.ts";

// Import for local use
import * as actions from "./actions/index.ts";
import * as providers from "./providers/index.ts";

/**
 * Advanced providers - extended context and state management
 */
export const advancedProviders = [
	providers.roleProvider,
	providers.settingsProvider,
	experienceProvider,
];

/**
 * Advanced actions - extended agent capabilities
 */
export const advancedActions = [
	withCanonicalActionDocs(actions.followRoomAction),
	withCanonicalActionDocs(actions.generateImageAction),
	withCanonicalActionDocs(actions.thinkAction),
	withCanonicalActionDocs(actions.muteRoomAction),
	withCanonicalActionDocs(actions.unfollowRoomAction),
	withCanonicalActionDocs(actions.unmuteRoomAction),
	withCanonicalActionDocs(actions.updateRoleAction),
	withCanonicalActionDocs(actions.updateSettingsAction),
	withCanonicalActionDocs(recordExperienceAction),
];

/**
 * Advanced evaluators - memory, relationships, experience learning
 */
export const advancedEvaluators = [experienceEvaluator];

/**
 * Advanced services - extended service infrastructure
 */
export const advancedServices: ServiceClass[] = [
	{
		serviceType: "EXPERIENCE",
		start: async (runtime: IAgentRuntime) => {
			const { ExperienceService } = await import("./experience/service.ts");
			return ExperienceService.start(runtime);
		},
	} as unknown as ServiceClass,
];

/**
 * Combined advanced capabilities object
 */
export const advancedCapabilities = {
	providers: advancedProviders,
	actions: advancedActions,
	evaluators: advancedEvaluators,
	services: advancedServices,
};

export default advancedCapabilities;
