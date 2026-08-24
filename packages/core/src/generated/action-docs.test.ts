/**
 * Behavioral coverage for the generated canonical action/provider doc
 * aggregate. Drives the real enrichment consumers (`withCanonicalActionDocs`,
 * `withCanonicalProviderDocs`) across every generated row so lookup-key
 * integrity, complete-description injection, parameter round-tripping, and
 * aggregate version coherence fail loudly instead of silently degrading
 * prompt-facing docs. Deterministic: pure generated data plus the overlay
 * functions, no model, network, or database.
 */
import { describe, expect, it } from "vitest";
import {
	withCanonicalActionDocs,
	withCanonicalActionDocsAll,
	withCanonicalProviderDocs,
} from "../action-docs.ts";
import type { Action, Provider } from "../types/index.ts";
import {
	allActionDocs,
	allActionsSpec,
	allActionsSpecVersion,
	allProviderDocs,
	allProvidersSpec,
	allProvidersSpecVersion,
	coreActionDocs,
	coreActionsSpec,
	coreActionsSpecVersion,
	coreProviderDocs,
	coreProvidersSpec,
	coreProvidersSpecVersion,
} from "./action-docs.ts";

function bareAction(name: string): Action {
	return {
		name,
		description: "",
		handler: async () => true,
		validate: async () => true,
		examples: [],
	};
}

function bareProvider(name: string): Provider {
	return {
		name,
		description: "",
		get: async () => "",
	};
}

describe("generated action-docs aggregate", () => {
	it("keeps spec version constants coherent with their aggregates", () => {
		expect(coreActionsSpec.version).toBe(coreActionsSpecVersion);
		expect(allActionsSpec.version).toBe(allActionsSpecVersion);
		expect(coreProvidersSpec.version).toBe(coreProvidersSpecVersion);
		expect(allProvidersSpec.version).toBe(allProvidersSpecVersion);
	});

	it("keeps generated action names unique so name-keyed lookups cannot shadow rows", () => {
		// Consumers index these docs into name-keyed records via reduce; a
		// duplicate name would silently overwrite the earlier row.
		expect(new Set(coreActionDocs.map((doc) => doc.name)).size).toBe(
			coreActionDocs.length,
		);
		expect(new Set(allActionDocs.map((doc) => doc.name)).size).toBe(
			allActionDocs.length,
		);
	});

	it("keeps generated provider names unique so name-keyed lookups cannot shadow rows", () => {
		expect(new Set(coreProviderDocs.map((doc) => doc.name)).size).toBe(
			coreProviderDocs.length,
		);
		expect(new Set(allProviderDocs.map((doc) => doc.name)).size).toBe(
			allProviderDocs.length,
		);
	});

	it("carries a complete non-empty description for every generated doc", () => {
		for (const doc of [...allActionDocs, ...allProviderDocs]) {
			expect(
				doc.description.trim().length,
				`${doc.name} must declare a non-empty description`,
			).toBeGreaterThan(0);
		}
	});

	it("mirrors descriptionCompressed onto the complete description whenever present", () => {
		// Legacy compressed aliases must never carry semantically shortened
		// substitutes for compatibility consumers.
		for (const doc of allActionDocs) {
			if (doc.descriptionCompressed !== undefined) {
				expect(doc.descriptionCompressed, doc.name).toBe(doc.description);
			}
		}
		for (const doc of allProviderDocs) {
			if (doc.descriptionCompressed !== undefined) {
				expect(doc.descriptionCompressed, doc.name).toBe(doc.description);
			}
		}
	});

	it("keeps the core aggregates contained within the all aggregates", () => {
		const allActionNames = new Set(allActionDocs.map((doc) => doc.name));
		for (const doc of coreActionDocs) {
			expect(allActionNames.has(doc.name), doc.name).toBe(true);
		}
		const allProviderNames = new Set(allProviderDocs.map((doc) => doc.name));
		for (const doc of coreProviderDocs) {
			expect(allProviderNames.has(doc.name), doc.name).toBe(true);
		}
	});

	it("resolves every generated action row through the canonical enrichment lookup", () => {
		const bareActions = allActionDocs.map((doc) => bareAction(doc.name));
		const enriched = withCanonicalActionDocsAll(bareActions);

		expect(enriched).toHaveLength(allActionDocs.length);
		for (const [index, doc] of allActionDocs.entries()) {
			expect(enriched[index].description, doc.name).toBe(doc.description);
			expect(enriched[index].similes, doc.name).toEqual(doc.similes);
		}

		// The single-item entry point resolves identically for a probe row.
		const single = withCanonicalActionDocs(bareAction(allActionDocs[0].name));
		expect(single.description).toBe(allActionDocs[0].description);
	});

	it("round-trips generated parameters through enrichment preserving order, required flags, enums, and defaults", () => {
		for (const doc of allActionDocs) {
			if (!doc.parameters || doc.parameters.length === 0) continue;
			const enriched = withCanonicalActionDocs(bareAction(doc.name));
			const parameters = enriched.parameters ?? [];

			expect(
				parameters.map((p) => p.name),
				doc.name,
			).toEqual(doc.parameters.map((p) => p.name));
			expect(
				parameters.map((p) => p.required),
				doc.name,
			).toEqual(doc.parameters.map((p) => p.required));

			for (const [index, param] of doc.parameters.entries()) {
				const converted = parameters[index].schema;
				if (param.schema.enum) {
					expect(converted.enum, `${doc.name}.${param.name}`).toEqual(
						param.schema.enum,
					);
					expect(converted.enumValues, `${doc.name}.${param.name}`).toEqual(
						param.schema.enum,
					);
				}
				if (param.schema.default !== undefined) {
					expect(converted.default, `${doc.name}.${param.name}`).toEqual(
						param.schema.default,
					);
				}
			}
		}
	});

	it("resolves every generated provider row through the provider enrichment lookup", () => {
		for (const doc of allProviderDocs) {
			const enriched = withCanonicalProviderDocs(bareProvider(doc.name));
			expect(enriched.description, doc.name).toBe(doc.description);
		}
	});
});
