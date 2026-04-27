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

import { withCanonicalActionDocs } from "../../action-docs.ts";
import type { IAgentRuntime } from "../../types/index.ts";
import type { ServiceClass } from "../../types/plugin.ts";
// Clipboard imports
import {
	clipboardAppendAction,
	clipboardDeleteAction,
	clipboardListAction,
	clipboardProvider,
	clipboardReadAction,
	clipboardSearchAction,
	clipboardWriteAction,
	readAttachmentAction,
	readFileAction,
	removeFromClipboardAction,
	saveAttachmentToClipboardAction,
} from "./clipboard/index.ts";
import {
	experienceEvaluator,
	experienceProvider,
	recordExperienceAction,
} from "./experience/index.ts";

// Form imports
import {
	formContextProvider,
	formEvaluator,
	formRestoreAction,
} from "./form/index.ts";

// Personality imports
import {
	characterEvolutionEvaluator,
	manageMessageExamplesAction,
	managePostExamplesAction,
	manageStyleRulesAction,
	modifyCharacterAction,
	persistCharacterAction,
	setVoiceConfigAction,
	userPersonalityProvider,
} from "./personality/index.ts";

// Re-export action, provider, and evaluator modules
export * from "./actions/index.ts";
export * from "./clipboard/index.ts";
export * from "./evaluators/index.ts";
export * from "./experience/index.ts";
export * from "./form/index.ts";
export * from "./personality/index.ts";
export * from "./providers/index.ts";

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
	saveAttachmentToClipboardAction,
	removeFromClipboardAction,
	// Form actions
	formRestoreAction,
	// Personality actions
	modifyCharacterAction,
	setVoiceConfigAction,
	manageStyleRulesAction,
	manageMessageExamplesAction,
	managePostExamplesAction,
	persistCharacterAction,
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
