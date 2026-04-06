import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("PROVIDERS");

/**
 * Provider for retrieving list of all data providers available for the agent to use.
 * @type { Provider }
 */
/**
 * Object representing the providersProvider, which contains information about data providers available for the agent.
 *
 * @type {Provider}
 * @property {string} name - The name of the provider ("PROVIDERS").
 * @property {string} description - Description of the provider.
 * @property {Function} get - Async function that filters dynamic providers, creates formatted text for each provider, and provides data for potential use.
 * @param {IAgentRuntime} runtime - The runtime of the agent.
 * @param {Memory} _message - The memory message.
 * @returns {Object} An object containing the formatted text and data for potential programmatic use.
 */
export const providersProvider: Provider = {
	name: spec.name,
	description: spec.description,
	get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
		const allProviders = [...runtime.providers].sort(
			(left, right) =>
				(left.position ?? 0) - (right.position ?? 0) ||
				left.name.localeCompare(right.name),
		);
		const selectionHints = [
			"images, attachments, or visual content -> ATTACHMENTS",
			"specific people or agents -> ENTITIES",
			"connections between people -> RELATIONSHIPS",
			"factual lookup -> FACTS",
			"world or environment context -> WORLD",
		];

		// Filter providers with dynamic: true
		const dynamicProviders = allProviders.filter(
			(provider) => provider.dynamic === true,
		);

		const formatProviders = (providers: typeof allProviders, title: string) =>
			[
				title,
				`providers[${providers.length}]:`,
				...(providers.length > 0
					? providers.map(
							(provider) =>
								`- ${provider.name}: ${provider.description || "No description available"}`,
						)
					: ["- none"]),
				`provider_hints[${selectionHints.length}]:`,
				...selectionHints.map((hint) => `- ${hint}`),
			].join("\n");

		const dynamicSection = formatProviders(dynamicProviders, "# Providers");

		const providersWithDescriptions = formatProviders(
			allProviders,
			"# Available Providers",
		);

		const data = {
			dynamicProviders: dynamicProviders.map((provider) => ({
				name: provider.name,
				description: provider.description || "",
			})),
			allProviders: allProviders.map((provider) => ({
				name: provider.name,
				description: provider.description || "",
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
