/** Verifies canonical documentation enrichment preserves caller overrides and complete descriptions. */
import { expect, it } from "vitest";
import {
	withCanonicalActionDocsAll,
	withCanonicalProviderDocsAll,
} from "./action-docs.js";
import {
	requireActionSpec,
	requireProviderSpec,
} from "./generated/spec-helpers";
import type { Action, ActionParameter, Provider } from "./types/index.js";

it("enriches canonical and custom actions without replacing caller documentation", () => {
	const action: Action = {
		name: "REPLY",
		description: "",
		handler: async () => true,
		validate: async () => true,
		examples: [],
	};
	const parameter: ActionParameter = {
		name: "customParam",
		description: "Custom parameter description",
		required: true,
		schema: { type: "string" },
	};
	const override: Action = {
		...action,
		description: "My custom reply description",
		similes: ["CUSTOM_REPLY_SIMILE"],
		parameters: [parameter],
	};
	const custom = {
		...action,
		name: "CUSTOM_UNKNOWN_ACTION",
		description: "Perform a custom task",
	};
	const result = withCanonicalActionDocsAll([action, override, custom]);
	const canonical = requireActionSpec("REPLY");
	expect(result).toMatchObject([
		{
			description: canonical.description,
			descriptionCompressed: canonical.description,
			similes: canonical.similes,
		},
		{
			...override,
			descriptionCompressed: override.description,
			parameters: [
				{
					...parameter,
					descriptionCompressed: parameter.description,
				},
			],
		},
		{ ...custom, descriptionCompressed: custom.description },
	]);
	expect(action.description).toBe("");
	expect(parameter.descriptionCompressed).toBeUndefined();
});

it("enriches provider batches while preserving custom and overridden descriptions", () => {
	const provider: Provider = {
		name: "TIME",
		description: "",
		get: async () => "result",
	};
	const overridden = { ...provider, description: "My time context" };
	const custom = {
		...provider,
		name: "customProvider",
		description: "Custom runtime context",
	};
	const canonical = requireProviderSpec("TIME");
	expect(
		withCanonicalProviderDocsAll([provider, overridden, custom]),
	).toMatchObject([
		{
			...provider,
			description: canonical.description,
			descriptionCompressed: canonical.description,
		},
		{ ...overridden, descriptionCompressed: overridden.description },
		{ ...custom, descriptionCompressed: custom.description },
	]);
	expect(provider.description).toBe("");
});
