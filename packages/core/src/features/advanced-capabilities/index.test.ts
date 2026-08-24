/**
 * Deterministic unit tests for the advanced-capabilities composition barrel
 * (index.ts), driven entirely through the real module graph — no mocks.
 *
 * Covered: registration integrity of the exported provider/action/evaluator/
 * service bundles (non-empty names, callable surfaces, uniqueness), the
 * umbrella-promotion contract (each promoted parent stays registered beside
 * its `<PARENT>_<SUB>` virtuals, retrieval-facing `subActions` records exactly
 * the top-level virtual set, virtual handlers/validators wrap rather than
 * alias the parent's, and each virtual pins its subaction discriminator enum),
 * the canonical-docs merge filling `descriptionCompressed` with the complete
 * description for doc-wrapped actions, builder-built service classes carrying
 * static `serviceType`/`start` plus instance `capabilityDescription`, and the
 * aggregate/default export identity the plugin loader consumes.
 */
import { describe, expect, it } from "vitest";
import { Service } from "../../types/index.ts";
import {
	advancedActions,
	advancedCapabilities,
	default as advancedCapabilitiesDefault,
	advancedEvaluators,
	advancedProviders,
	advancedServices,
} from "./index.ts";

const UMBRELLAS = [
	"ROOM",
	"MESSAGE",
	"POST",
	"CHARACTER",
	"PERSONALITY",
] as const;

const DOC_WRAPPED_ACTIONS = [
	"ROOM",
	"ROLE",
	"SEARCH_EXPERIENCES",
	"EXPERIENCE",
	"PERSONALITY",
] as const;

interface PinnedDiscriminator {
	key: string;
	value: string;
	required: boolean;
}

/**
 * Reads the single-value discriminator enum a virtual exposes to the planner's
 * tool schema — the same first-match lookup tool inspectors perform over
 * `parameters` (canonical `action` key wins over legacy aliases).
 */
function pinnedDiscriminator(actionName: string): PinnedDiscriminator {
	const action = advancedActions.find((a) => a.name === actionName);
	expect(action, `${actionName} should be registered`).toBeDefined();
	const discriminator = (action?.parameters ?? []).find(
		(parameter) =>
			parameter.schema &&
			Array.isArray((parameter.schema as { enum?: unknown[] }).enum) &&
			(parameter.schema as { enum: unknown[] }).enum.length === 1,
	);
	expect(
		discriminator,
		`${actionName} should pin one discriminator`,
	).toBeDefined();
	const schema = discriminator?.schema as { enum: string[] };
	return {
		key: discriminator?.name ?? "",
		value: schema.enum[0],
		required: discriminator?.required ?? true,
	};
}

describe("advancedCapabilities provider bundle", () => {
	it("registers providers with non-empty unique names and a callable get", () => {
		expect(advancedProviders.length).toBeGreaterThan(0);
		for (const provider of advancedProviders) {
			expect(typeof provider.name).toBe("string");
			expect(provider.name.length).toBeGreaterThan(0);
			expect(typeof provider.get).toBe("function");
		}
		const names = advancedProviders.map((provider) => provider.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("exposes the expected provider registration surface", () => {
		expect([...advancedProviders].map((p) => p.name).sort()).toEqual([
			"CHARACTER_GATE_NOTICE",
			"CONTACTS",
			"FACTS",
			"FOLLOW_UPS",
			"RELATIONSHIPS",
			"ROLES",
			"SETTINGS",
			"experienceProvider",
			"userPersonalityPreferences",
		]);
	});
});

describe("advancedCapabilities action bundle", () => {
	it("registers every action with name, description, handler and validate", () => {
		expect(advancedActions.length).toBeGreaterThan(0);
		for (const action of advancedActions) {
			expect(typeof action.name).toBe("string");
			expect(action.name.length).toBeGreaterThan(0);
			expect((action.description ?? "").length).toBeGreaterThan(0);
			expect(typeof action.handler).toBe("function");
			expect(typeof action.validate).toBe("function");
		}
	});

	it("registers unique action names across the whole bundle", () => {
		const names = advancedActions.map((action) => action.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it.each(UMBRELLAS)(
		"keeps %s registered beside its promoted virtuals and records them on subActions",
		(umbrella) => {
			const parent = advancedActions.find((a) => a.name === umbrella);
			expect(parent, `${umbrella} parent should stay registered`).toBeDefined();
			const virtualNames = advancedActions
				.filter((a) => a.name !== umbrella && a.name.startsWith(`${umbrella}_`))
				.map((a) => a.name);
			expect(virtualNames.length).toBeGreaterThan(0);
			const recorded = [...(parent?.subActions ?? [])];
			for (const name of virtualNames) {
				expect(recorded).toContain(name);
			}
			const prefixedStrays = recorded.filter(
				(entry) =>
					typeof entry === "string" && entry.startsWith(`${umbrella}_`),
			);
			expect(prefixedStrays.sort()).toEqual([...virtualNames].sort());
		},
	);

	it("wraps each virtual handler and validator instead of aliasing the parent's", () => {
		for (const umbrella of UMBRELLAS) {
			const parent = advancedActions.find((a) => a.name === umbrella);
			const virtuals = advancedActions.filter(
				(a) => a !== parent && a.name.startsWith(`${umbrella}_`),
			);
			for (const virtual of virtuals) {
				expect(virtual.handler).not.toBe(parent?.handler);
				expect(virtual.validate).not.toBe(parent?.validate);
			}
		}
	});

	it("pins each virtual's discriminator enum to its own subaction value", () => {
		expect(pinnedDiscriminator("MESSAGE_SEND")).toEqual({
			key: "action",
			value: "send",
			required: false,
		});
		expect(pinnedDiscriminator("ROOM_MUTE")).toEqual({
			key: "action",
			value: "mute",
			required: false,
		});
		expect(pinnedDiscriminator("POST_READ")).toEqual({
			key: "action",
			value: "read",
			required: false,
		});
		expect(pinnedDiscriminator("PERSONALITY_SET_TRAIT")).toEqual({
			key: "action",
			value: "set_trait",
			required: false,
		});
	});

	it("fills descriptionCompressed with the complete description for doc-wrapped actions", () => {
		for (const name of DOC_WRAPPED_ACTIONS) {
			const action = advancedActions.find((a) => a.name === name);
			expect(action, `${name} should be registered`).toBeDefined();
			expect(action?.descriptionCompressed).toBe(action?.description);
			expect((action?.descriptionCompressed ?? "").length).toBeGreaterThan(0);
		}
	});

	it("registers non-promoted single-surface actions exactly once", () => {
		for (const name of ["ROLE", "SEARCH_EXPERIENCES", "EXPERIENCE"]) {
			expect(
				advancedActions.filter((a) => a.name === name).length,
				`${name} should appear once`,
			).toBe(1);
		}
	});
});

describe("advancedCapabilities evaluator bundle", () => {
	it("registers unique evaluator names", () => {
		const names = advancedEvaluators.map((evaluator) => evaluator.name);
		expect(names.length).toBeGreaterThan(0);
		expect(new Set(names).size).toBe(names.length);
	});

	it("exposes the expected evaluator registration surface", () => {
		expect([...advancedEvaluators].map((e) => e.name).sort()).toEqual([
			"experiencePatterns",
			"factMemory",
			"identities",
			"preferences",
			"relationships",
			"skillProposal",
			"skillRefinement",
			"success",
		]);
	});

	it("gives every post-turn evaluator a complete single-call surface", () => {
		for (const evaluator of advancedEvaluators) {
			expect((evaluator.description ?? "").length).toBeGreaterThan(0);
			expect(typeof evaluator.shouldRun).toBe("function");
			expect(typeof evaluator.prepare).toBe("function");
			expect(typeof evaluator.parse).toBe("function");
			expect(typeof evaluator.prompt).toBe("function");
			expect(Array.isArray(evaluator.processors)).toBe(true);
			expect(evaluator.processors?.length ?? 0).toBeGreaterThan(0);
			expect((evaluator.schema as { type?: string } | undefined)?.type).toBe(
				"object",
			);
		}
	});
});

describe("advancedCapabilities service bundle", () => {
	it("registers builder-built service classes with unique service types", () => {
		const types = advancedServices.map((service) => service.serviceType);
		expect(types.sort()).toEqual([
			"CHARACTER_MANAGEMENT",
			"EXPERIENCE",
			"PERSONALITY_STORE",
		]);
		expect(new Set(types).size).toBe(types.length);
	});

	it("exposes a static start hook on every service class", () => {
		for (const service of advancedServices) {
			expect(typeof service.start).toBe("function");
		}
	});

	it("builds instances that extend Service with a capability description", () => {
		for (const service of advancedServices) {
			const instance = new service();
			expect(instance).toBeInstanceOf(Service);
			expect(typeof instance.capabilityDescription).toBe("string");
			expect(instance.capabilityDescription.length).toBeGreaterThan(0);
		}
	});
});

describe("advancedCapabilities aggregate export", () => {
	it("aggregates the four exported bundles by reference", () => {
		expect(advancedCapabilities.providers).toBe(advancedProviders);
		expect(advancedCapabilities.actions).toBe(advancedActions);
		expect(advancedCapabilities.evaluators).toBe(advancedEvaluators);
		expect(advancedCapabilities.services).toBe(advancedServices);
	});

	it("exports the same object as the module default", () => {
		expect(advancedCapabilitiesDefault).toBe(advancedCapabilities);
	});
});
