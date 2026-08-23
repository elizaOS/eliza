/**
 * Unit tests for action and provider documentation enrichment.
 */

import { describe, expect, it } from "vitest";
import {
	withCanonicalActionDocs,
	withCanonicalActionDocsAll,
	withCanonicalProviderDocs,
	withCanonicalProviderDocsAll,
} from "./action-docs.js";
import type { Action, Provider } from "./types/index.js";

describe("withCanonicalActionDocs", () => {
	it("enriches actions without altering non-canonical actions while adding compressed descriptions", () => {
		const customAction: Action = {
			name: "CUSTOM_UNKNOWN_ACTION",
			description: "Perform a custom task for tests",
			handler: async () => true,
			validate: async () => true,
			examples: [],
		};

		const enriched = withCanonicalActionDocs(customAction);

		expect(enriched.name).toBe("CUSTOM_UNKNOWN_ACTION");
		expect(enriched.description).toBe("Perform a custom task for tests");
		expect(enriched.descriptionCompressed).toBeDefined();
		expect(typeof enriched.descriptionCompressed).toBe("string");
	});

	it("merges canonical docs onto actions when matching names exist", () => {
		const replyAction: Action = {
			name: "REPLY",
			description: "",
			handler: async () => true,
			validate: async () => true,
			examples: [],
		};

		const enriched = withCanonicalActionDocs(replyAction);

		expect(enriched.description).toBeTruthy();
		expect(enriched.descriptionCompressed).toBeTruthy();
		expect(enriched.similes).toBeDefined();
	});

	it("preserves explicit descriptions and similes on actions with canonical matches", () => {
		const customAction: Action = {
			name: "REPLY",
			description: "My custom reply description",
			similes: ["CUSTOM_REPLY_SIMILE"],
			parameters: [
				{
					name: "customParam",
					description: "Custom parameter description",
					required: true,
					schema: { type: "string" },
				},
			],
			handler: async () => true,
			validate: async () => true,
			examples: [],
		};

		const enriched = withCanonicalActionDocs(customAction);

		expect(enriched.description).toBe("My custom reply description");
		expect(enriched.similes).toEqual(["CUSTOM_REPLY_SIMILE"]);
		expect(enriched.parameters?.[0].name).toBe("customParam");
		expect(enriched.parameters?.[0].descriptionCompressed).toBeDefined();
	});
});

describe("withCanonicalActionDocsAll", () => {
	it("maps multiple actions through withCanonicalActionDocs", () => {
		const actions: Action[] = [
			{
				name: "ACTION_A",
				description: "First action",
				handler: async () => true,
				validate: async () => true,
				examples: [],
			},
			{
				name: "ACTION_B",
				description: "Second action",
				handler: async () => true,
				validate: async () => true,
				examples: [],
			},
		];

		const result = withCanonicalActionDocsAll(actions);
		expect(result).toHaveLength(2);
		expect(result[0].descriptionCompressed).toBeDefined();
		expect(result[1].descriptionCompressed).toBeDefined();
	});
});

describe("withCanonicalProviderDocs", () => {
	it("enriches provider definitions with compressed descriptions", () => {
		const customProvider: Provider = {
			name: "customProvider",
			description: "Provides custom runtime context",
			get: async () => "result",
		};

		const enriched = withCanonicalProviderDocs(customProvider);
		expect(enriched.name).toBe("customProvider");
		expect(enriched.description).toBe("Provides custom runtime context");
		expect(enriched.descriptionCompressed).toBeDefined();
	});
});

describe("withCanonicalProviderDocsAll", () => {
	it("maps an array of providers through withCanonicalProviderDocs", () => {
		const providers: Provider[] = [
			{
				name: "p1",
				description: "Provider one",
				get: async () => "1",
			},
		];

		const result = withCanonicalProviderDocsAll(providers);
		expect(result).toHaveLength(1);
		expect(result[0].descriptionCompressed).toBeDefined();
	});
});
