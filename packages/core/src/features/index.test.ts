/**
 * Deterministic unit tests for the core-capabilities index: the trust,
 * secrets-manager, and plugin-manager bundles exported as `coreCapabilities`.
 * Every assertion drives the real composed module — no mocks — covering the
 * registration contract consumers rely on: canonical grouping, non-empty and
 * collision-free provider/action/service lists, documented service types,
 * startable service classes, eager TRUST subaction promotion with the parent
 * retained, and init-hook presence.
 */
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../actions/promote-subactions.ts";
import coreCapabilitiesDefault, {
	coreCapabilities,
	pluginManagerCapability,
	secretsCapability,
	trustCapability,
} from "./index.ts";
import { trustAction } from "./trust/actions/trust.ts";

type CapabilityBundle = {
	providers: { name: string }[];
	actions: { name: string }[];
	services: { serviceType: string; start: unknown }[];
	init?: unknown;
};

function declaredInit(capability: object): unknown {
	return (capability as CapabilityBundle).init;
}

const capabilities = [
	["trust", trustCapability],
	["secretsManager", secretsCapability],
	["pluginManager", pluginManagerCapability],
] as const;

describe("coreCapabilities composition", () => {
	it("groups the three capabilities under their canonical keys and mirrors the default export", () => {
		expect(Object.keys(coreCapabilities).sort()).toEqual([
			"pluginManager",
			"secretsManager",
			"trust",
		]);
		expect(coreCapabilities.trust).toBe(trustCapability);
		expect(coreCapabilities.secretsManager).toBe(secretsCapability);
		expect(coreCapabilities.pluginManager).toBe(pluginManagerCapability);
		expect(coreCapabilitiesDefault).toBe(coreCapabilities);
	});

	it("exposes a non-empty provider, action, and service bundle for every capability", () => {
		for (const [key, capability] of capabilities) {
			expect(
				capability.providers.length,
				`${key} providers must not be empty`,
			).toBeGreaterThan(0);
			expect(
				capability.actions.length,
				`${key} actions must not be empty`,
			).toBeGreaterThan(0);
			expect(
				capability.services.length,
				`${key} services must not be empty`,
			).toBeGreaterThan(0);
		}
	});

	it("registers collision-free component names within each capability", () => {
		for (const [key, capability] of capabilities) {
			const providerNames = capability.providers.map((p) => p.name);
			expect(new Set(providerNames).size, `${key} provider names`).toBe(
				providerNames.length,
			);
			const actionNames = capability.actions.map((a) => a.name);
			expect(new Set(actionNames).size, `${key} action names`).toBe(
				actionNames.length,
			);
			const serviceTypes = capability.services.map((s) => s.serviceType);
			expect(new Set(serviceTypes).size, `${key} service types`).toBe(
				serviceTypes.length,
			);
		}
	});

	it("wires each capability's documented service types in registration order", () => {
		expect(trustCapability.services.map((s) => s.serviceType)).toEqual([
			"trust-engine",
			"security-module",
			"credential-protector",
			"contextual-permissions",
		]);
		expect(secretsCapability.services.map((s) => s.serviceType)).toEqual([
			"SECRETS",
			"PLUGIN_ACTIVATOR",
			"SETUP",
		]);
		expect(pluginManagerCapability.services.map((s) => s.serviceType)).toEqual([
			"plugin_manager",
			"core_manager",
		]);
	});

	it("builds every service as a class carrying its type and a start factory", () => {
		for (const [key, capability] of capabilities) {
			for (const service of capability.services) {
				expect(typeof service.serviceType, `${key} serviceType`).toBe("string");
				expect(
					service.serviceType.length,
					`${key} serviceType`,
				).toBeGreaterThan(0);
				expect(typeof service.start, `${key} start hook`).toBe("function");
			}
		}
	});

	it("eagerly registers the TRUST umbrella plus one promoted virtual per subaction", () => {
		const expectedNames = promoteSubactionsToActions(trustAction).map(
			(action) => action.name,
		);
		expect(trustCapability.actions.length).toBe(expectedNames.length);
		expect(trustCapability.actions.map((action) => action.name)).toEqual(
			expectedNames,
		);
		expect(trustCapability.actions[0]).toBe(trustAction);
		const virtuals = trustCapability.actions.slice(1);
		expect(virtuals.length).toBeGreaterThan(0);
		for (const virtual of virtuals) {
			expect(virtual.name.startsWith(`${trustAction.name}_`)).toBe(true);
		}
	});

	it("declares an init hook only on the trust capability", () => {
		expect(typeof declaredInit(trustCapability)).toBe("function");
		expect(declaredInit(secretsCapability)).toBeUndefined();
		expect(declaredInit(pluginManagerCapability)).toBeUndefined();
	});
});
