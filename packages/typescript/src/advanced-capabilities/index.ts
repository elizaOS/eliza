/**
 * Advanced Capabilities
 *
 * Extended functionality that can be enabled with `enableExtendedCapabilities: true`
 * or `advancedCapabilities: true` in plugin initialization.
 *
 * These provide additional agent features:
 * - Extended providers (facts, contacts, relationships, roles, settings, knowledge, clipboard, form, personality)
 * - Advanced actions (contacts management, room management, image generation, clipboard, form, personality, etc.)
 * - Evaluators (reflection, relationship extraction, experience learning, form extraction, character evolution)
 * - Additional services (experience, clipboard, form, personality)
 */

import { withCanonicalActionDocs } from "../action-docs.ts";
import type { IAgentRuntime } from "../types/index.ts";
import type { ServiceClass } from "../types/plugin.ts";
import {
	experienceEvaluator,
	experienceProvider,
	recordExperienceAction,
} from "./experience/index.ts";

// Clipboard imports
import {
	clipboardProvider,
	clipboardWriteAction,
	clipboardReadAction,
	clipboardSearchAction,
	clipboardListAction,
	clipboardDeleteAction,
	clipboardAppendAction,
	readFileAction,
	readAttachmentAction,
	removeFromClipboardAction,
} from "./clipboard/index.ts";

// Form imports
import {
	formRestoreAction,
	formEvaluator,
	formContextProvider,
} from "./form/index.ts";

// Personality imports
import {
	modifyCharacterAction,
	characterEvolutionEvaluator,
	userPersonalityProvider,
} from "./personality/index.ts";

// Re-export action, provider, and evaluator modules
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./providers/index.ts";
export * from "./experience/index.ts";
export * from "./clipboard/index.ts";
export * from "./form/index.ts";
export * from "./personality/index.ts";

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
	clipboardProvider,
	formContextProvider,
	userPersonalityProvider,
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
	// Clipboard actions
	clipboardWriteAction,
	clipboardReadAction,
	clipboardSearchAction,
	clipboardListAction,
	clipboardDeleteAction,
	clipboardAppendAction,
	readFileAction,
	readAttachmentAction,
	removeFromClipboardAction,
	// Form actions
	formRestoreAction,
	// Personality actions
	modifyCharacterAction,
];

/**
 * Advanced evaluators - memory, relationships, experience learning, form, personality
 */
export const advancedEvaluators = [
	experienceEvaluator,
	formEvaluator,
	characterEvolutionEvaluator,
];

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
	{
		serviceType: "FORM",
		start: async (runtime: IAgentRuntime) => {
			const { FormService } = await import("./form/service.ts");
			return FormService.start(runtime);
		},
	} as unknown as ServiceClass,
	{
		serviceType: "CHARACTER_MANAGEMENT",
		start: async (runtime: IAgentRuntime) => {
			const { CharacterFileManager } = await import(
				"./personality/services/character-file-manager.ts"
			);
			return CharacterFileManager.start(runtime);
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
