/**
 * Minimal first-party capability composition for Workerd-hosted Eliza agents.
 * It preserves the canonical reply loop and conversational context providers
 * while excluding filesystem, media generation, plugin management, autonomy,
 * and background services that require a dedicated host.
 */

import { withCanonicalActionDocs } from "../../action-docs.ts";
import { EvaluatorService } from "../../services/evaluator.ts";
import type {
	Plugin,
	Provider,
	RegisteredEvaluator,
	ServiceClass,
} from "../../types/index.ts";
import { ignoreAction } from "./actions/ignore.ts";
import { noneAction } from "./actions/none.ts";
import { replyAction } from "./actions/reply.ts";
import {
	type CapabilityConfig,
	type CapabilitySettingFlags,
	type ExplicitCapabilityOptions,
	resolveCapabilityConfig,
} from "./config.ts";
import { actionStateProvider } from "./providers/actionState.ts";
import { actionsProvider } from "./providers/actions.ts";
import { characterProvider } from "./providers/character.ts";
import { currentTimeProvider } from "./providers/currentTime.ts";
import {
	platformChatContextProvider,
	platformUserContextProvider,
} from "./providers/platformContext.ts";
import { providersProvider } from "./providers/providers.ts";
import { recentMessagesProvider } from "./providers/recentMessages.ts";
import { replyContextProvider } from "./providers/replyContext.ts";
import { runtimeModelContextProvider } from "./providers/runtimeModelContext.ts";

export type {
	CapabilityConfig,
	CapabilitySettingFlags,
	ExplicitCapabilityOptions,
};
export { recentMessagesProvider, resolveCapabilityConfig };

const unsupportedCapabilityKeys = [
	"enableExtended",
	"advancedCapabilities",
	"enableAutonomy",
	"enableTrust",
	"enableSecretsManager",
	"enablePluginManager",
] as const satisfies ReadonlyArray<keyof CapabilityConfig>;

export const basicProviders: Provider[] = [
	actionsProvider,
	actionStateProvider,
	characterProvider,
	currentTimeProvider,
	platformChatContextProvider,
	platformUserContextProvider,
	providersProvider,
	recentMessagesProvider,
	replyContextProvider,
	runtimeModelContextProvider,
];

export const basicActions = [
	withCanonicalActionDocs(replyAction),
	withCanonicalActionDocs(ignoreAction),
	withCanonicalActionDocs(noneAction),
];

export const basicEvaluators: RegisteredEvaluator[] = [];
export const basicServices: ServiceClass[] = [EvaluatorService];

export const basicCapabilities = {
	providers: basicProviders,
	actions: basicActions,
	evaluators: basicEvaluators,
	services: basicServices,
};

export function createBasicCapabilitiesPlugin(
	config: CapabilityConfig = {},
): Plugin {
	const unsupported = unsupportedCapabilityKeys.filter((key) => config[key]);
	if (unsupported.length > 0) {
		throw new Error(
			`Workerd runtime does not support core capability flags: ${unsupported.join(", ")}`,
		);
	}

	const providers = config.skipCharacterProvider
		? basicProviders.filter((provider) => provider.name !== "CHARACTER")
		: basicProviders;

	return {
		name: "basic-capabilities",
		description: "Workerd conversational core actions and context providers.",
		actions: config.disableBasic ? [] : basicActions,
		providers: config.disableBasic ? [] : providers,
		evaluators: basicEvaluators,
		services: basicServices,
	};
}

export default basicCapabilities;
