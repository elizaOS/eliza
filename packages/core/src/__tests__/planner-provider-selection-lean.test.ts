/**
 * Planner-turn provider selection is lean by default: an undeclared plugin
 * provider resolves to the "general" context — composed on ordinary chat turns,
 * skipped on narrow tool/planner turns — while declared contexts, gate-only
 * declarations (contextGate.anyOf), catalog-mapped names, and
 * `alwaysInResponseState` opt-ins route as declared, and the composed prompt
 * footprint actually drops on the narrow turn. Real in-memory AgentRuntime
 * (real registration path, real composeState); no database or model.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { selectV5PlannerStateProviderNames } from "../services/message";
import type { Character, Memory, Provider, UUID } from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeMessage(id: string): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "check my wallet" },
	};
}

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: { name: "lean-selection-test" } as Character,
	});
	// The flood class: a plugin provider with no contexts/contextGate whose
	// output would ride every planner turn under include-everything defaults.
	const noisy: Provider = {
		name: "NOISY_PLUGIN_SIGNAL",
		get: async () => ({
			text: `NOISY-PAYLOAD ${"x".repeat(2000)}`,
			values: {},
			data: {},
		}),
	};
	const walletDeclared: Provider = {
		name: "WALLET_SIGNAL",
		contexts: ["wallet"],
		get: async () => ({ text: "WALLET-PAYLOAD", values: {}, data: {} }),
	};
	const alwaysOn: Provider = {
		name: "ALWAYS_ON_SIGNAL",
		dynamic: true,
		alwaysInResponseState: true,
		get: async () => ({ text: "ALWAYS-PAYLOAD", values: {}, data: {} }),
	};
	// Declares ONLY a contextGate (the world-provider shape). Registration must
	// not clobber it with the general fallback, and selection must honor the
	// gate's anyOf.
	const gateOnly: Provider = {
		name: "WALLET_GATED_SIGNAL",
		contextGate: { anyOf: ["wallet"] },
		get: async () => ({ text: "GATED-WALLET-PAYLOAD", values: {}, data: {} }),
	};
	// Undeclared but catalog-mapped (code/automation): must ride coding planner
	// turns, not ordinary chat turns.
	const catalogMapped: Provider = {
		name: "AVAILABLE_AGENTS",
		get: async () => ({ text: "AGENTS-PAYLOAD", values: {}, data: {} }),
	};
	runtime.registerProvider(noisy);
	runtime.registerProvider(walletDeclared);
	runtime.registerProvider(alwaysOn);
	runtime.registerProvider(gateOnly);
	runtime.registerProvider(catalogMapped);
	return runtime;
}

describe("v5 planner provider selection — lean by default", () => {
	it("keeps an undeclared provider on a general turn and drops it from a narrow turn", () => {
		const runtime = makeRuntime();
		const message = makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

		const general = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["general"],
			userRoles: ["OWNER"],
		});
		expect(general).toContain("NOISY_PLUGIN_SIGNAL");
		expect(general).toContain("ALWAYS_ON_SIGNAL");
		expect(general).not.toContain("WALLET_SIGNAL");

		const narrow = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["wallet"],
			userRoles: ["OWNER"],
		});
		expect(narrow).not.toContain("NOISY_PLUGIN_SIGNAL");
		expect(narrow).toContain("WALLET_SIGNAL"); // still fires when relevant
		expect(narrow).toContain("ALWAYS_ON_SIGNAL"); // explicit always-on opt-in
	});

	it("honors a contextGate-only declaration instead of clobbering it with the general fallback", () => {
		const runtime = makeRuntime();
		const message = makeMessage("cccccccc-cccc-cccc-cccc-cccccccccccc");

		const narrow = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["wallet"],
			userRoles: ["OWNER"],
		});
		expect(narrow).toContain("WALLET_GATED_SIGNAL");

		const general = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["general"],
			userRoles: ["OWNER"],
		});
		expect(general).not.toContain("WALLET_GATED_SIGNAL");
	});

	it("routes catalog-mapped orchestrator providers to coding turns, not ordinary chat", () => {
		const runtime = makeRuntime();
		const message = makeMessage("dddddddd-dddd-dddd-dddd-dddddddddddd");

		const coding = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["code"],
			userRoles: ["OWNER"],
		});
		expect(coding).toContain("AVAILABLE_AGENTS");

		const general = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["general"],
			userRoles: ["OWNER"],
		});
		expect(general).not.toContain("AVAILABLE_AGENTS");
	});

	it("drops the composed prompt footprint on the narrow turn", async () => {
		const runtime = makeRuntime();
		const message = makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

		const general = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["general"],
			userRoles: ["OWNER"],
		});
		const narrow = selectV5PlannerStateProviderNames({
			runtime,
			message,
			selectedContexts: ["wallet"],
			userRoles: ["OWNER"],
		});

		const generalState = await runtime.composeState(
			message,
			general,
			true,
			true,
		);
		const narrowState = await runtime.composeState(message, narrow, true, true);

		expect(generalState.text).toContain("NOISY-PAYLOAD");
		expect(narrowState.text).not.toContain("NOISY-PAYLOAD");
		expect(narrowState.text).toContain("WALLET-PAYLOAD");
		expect(narrowState.text).toContain("ALWAYS-PAYLOAD");
		expect(narrowState.text.length).toBeLessThan(generalState.text.length);
	});

	it("warns at registration only for an undeclared, non-dynamic, uncataloged provider", () => {
		const runtime = new AgentRuntime({
			character: { name: "lean-warning-test" } as Character,
		});
		const warnSpy = vi.spyOn(runtime.logger, "warn");
		const get = async () => ({ text: "", values: {}, data: {} });

		runtime.registerProvider({ name: "UNDECLARED_PLUGIN", get });
		runtime.registerProvider({ name: "SCOPED", contexts: ["wallet"], get });
		runtime.registerProvider({
			name: "ALWAYS",
			alwaysInResponseState: true,
			get,
		});
		runtime.registerProvider({ name: "DYN", dynamic: true, get });
		runtime.registerProvider({ name: "walletBalance", get }); // catalog-mapped

		const warned = warnSpy.mock.calls
			.filter(([, message]) => String(message).includes("declares no contexts"))
			.map(([context]) => (context as { provider?: string }).provider);
		expect(warned).toEqual(["UNDECLARED_PLUGIN"]);
	});
});
