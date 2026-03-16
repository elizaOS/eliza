<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/providers.ts
import { requireProviderSpec } from "../../generated/spec-helpers.ts";
========
>>>>>>>> origin/odi-dev:packages/typescript/src/bootstrap/providers/providers.ts
import type {
  IAgentRuntime,
  Memory,
  Provider,
  State,
} from "../../types/index.ts";
import { addHeader } from "../../utils.ts";
<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/providers.ts

// Get text content from centralized specs
const spec = requireProviderSpec("PROVIDERS");
========
>>>>>>>> origin/odi-dev:packages/typescript/src/bootstrap/providers/providers.ts

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
<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/providers.ts
  name: spec.name,
  description: spec.description,
========
  name: "PROVIDERS",
  description:
    "List of all data providers the agent can use to get additional information",
>>>>>>>> origin/odi-dev:packages/typescript/src/bootstrap/providers/providers.ts
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const dynamicProviders = runtime.providers.filter(
      (provider) => provider.dynamic === true,
    );

<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/providers.ts
========
    // Filter providers with dynamic: true
    const dynamicProviders = allProviders.filter(
      (provider) => provider.dynamic === true,
    );

    // Create formatted text for each provider
>>>>>>>> origin/odi-dev:packages/typescript/src/bootstrap/providers/providers.ts
    const dynamicDescriptions = dynamicProviders.map((provider) => {
      return `- **${provider.name}**: ${provider.description || "No description available"}`;
    });

<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/providers.ts
========
    const allDescriptions = allProviders.map((provider) => {
      return `- **${provider.name}**: ${provider.description || "No description available"}`;
    });

    // Create the header text
>>>>>>>> origin/odi-dev:packages/typescript/src/bootstrap/providers/providers.ts
    const headerText =
      "# Providers\n\nThese providers are available for the agent to select and use:";

    const dynamicSection =
      dynamicDescriptions.length > 0
        ? addHeader(headerText, dynamicDescriptions.join("\n"))
        : addHeader(
            headerText,
            "No dynamic providers are currently available.",
          );

    const providersWithDescriptions = addHeader(
      "# Available Providers",
<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/providers.ts
      dynamicDescriptions.join("\n"),
========
      allDescriptions.join("\n"),
>>>>>>>> origin/odi-dev:packages/typescript/src/bootstrap/providers/providers.ts
    );

    const data = {
      dynamicProviders: dynamicProviders.map((provider) => ({
        name: provider.name,
        description: provider.description || "",
<<<<<<<< HEAD:packages/typescript/src/basic-capabilities/providers/providers.ts
========
      })),
      allProviders: allProviders.map((provider) => ({
        name: provider.name,
        description: provider.description || "",
        dynamic: provider.dynamic === true,
>>>>>>>> origin/odi-dev:packages/typescript/src/bootstrap/providers/providers.ts
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
