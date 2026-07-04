/**
 * PROVIDERS provider — injects the catalog of available data providers into the
 * planner prompt so the model can pick which context sources to pull on the next
 * turn. Renders each provider's (compressed) description alongside a set of
 * selection hints that map request kinds to provider names, and filters the list
 * to providers whose declared contexts match the turn's active routing contexts.
 * Suppresses the list entirely when the message looks like non-actionable
 * chatter. Part of the basic-capabilities bundle.
 */

import {
	getProviderSpec,
	requireProviderSpec,
} from "../../../generated/spec-helpers.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import { resolveProviderContexts } from "../../../utils/context-catalog";
import {
	getActiveRoutingContextsForTurn,
	shouldIncludeByContext,
} from "../../../utils/context-routing.ts";
import { compressPromptDescription } from "../../../utils/prompt-compression.ts";
import { looksLikeNonActionableChatter } from "./non-actionable-chatter.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("PROVIDERS");

export const providersProvider: Provider = {
	name: spec.name,
	description: spec.description,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: true,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
		const allProviders = [...runtime.providers].sort(
			(left, right) =>
				(left.position ?? 0) - (right.position ?? 0) ||
				left.name.localeCompare(right.name),
		);
		const activeContexts = getActiveRoutingContextsForTurn(state, message);
		const isInContext = (provider: Provider) =>
			shouldIncludeByContext(resolveProviderContexts(provider), activeContexts);
		const contextFilteredProviders = allProviders.filter(isInContext);
		const visibleProviders = looksLikeNonActionableChatter(message)
			? []
			: contextFilteredProviders;
		const selectionHints = [
			"images, attachments, or visual content -> ATTACHMENTS",
			"uploaded files or stored documents -> DOCUMENTS",
			"specific people or agents -> ENTITIES",
			"connections between people -> RELATIONSHIPS",
			"current platform chat or user identity -> PLATFORM_CHAT_CONTEXT, PLATFORM_USER_CONTEXT",
			"factual lookup -> FACTS",
			"world or environment context -> WORLD",
		];

		// Filter providers with dynamic: true
		const dynamicProviders = visibleProviders.filter(
			(provider) => provider.dynamic === true,
		);

		const renderDescription = (provider: Provider): string => {
			const providerSpec = getProviderSpec(provider.name);
			return (
				provider.descriptionCompressed ??
				providerSpec?.descriptionCompressed ??
				(provider.description
					? compressPromptDescription(provider.description)
					: "No description available")
			);
		};

		const formatProviders = (providers: typeof allProviders, title: string) =>
			[
				title,
				`providers: ${providers.length}`,
				...(providers.length > 0
					? providers.map(
							(provider) =>
								`- ${provider.name}: ${renderDescription(provider)}`,
						)
					: ["- none"]),
				`provider_hints: ${selectionHints.length}`,
				...selectionHints.map((hint) => `- ${hint}`),
			].join("\n");

		const dynamicSection = formatProviders(dynamicProviders, "# Providers");

		const providersWithDescriptions = formatProviders(
			visibleProviders,
			"# Available Providers",
		);

		const data = {
			dynamicProviders: dynamicProviders.map((provider) => ({
				name: provider.name,
				description: renderDescription(provider),
			})),
			allProviders: visibleProviders.map((provider) => ({
				name: provider.name,
				description: renderDescription(provider),
				dynamic: provider.dynamic === true,
			})),
		};

		const values = {
			providersWithDescriptions,
		};

		return {
			text: dynamicSection,
			data,
			values,
		};
	},
};
