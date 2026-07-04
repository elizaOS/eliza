/**
 * Unit tests for selectV5PlannerStateProviderNames, the v5 planner
 * state-provider selection (#13203): a provider's FULL declared contextGate
 * (anyOf/allOf/noneOf) must gate its planner inclusion, undeclared providers
 * resolve through the provider-context catalog, and `alwaysInResponseState`
 * providers (RECENT_ERRORS) are composed on every turn. Deterministic fake
 * runtime with literal provider fixtures — no live model or database.
 */
import { describe, expect, it } from "vitest";
import { recentErrorsProvider } from "../providers/recent-errors";
import type { Provider } from "../types/components";
import type { AgentContext } from "../types/contexts";
import type { IAgentRuntime, Memory, UUID } from "../types/index";
import { selectV5PlannerStateProviderNames } from "./message";

function provider(overrides: Partial<Provider> & { name: string }): Provider {
	return {
		description: "test provider",
		get: async () => ({ text: "" }),
		...overrides,
	} as Provider;
}

function makeRuntime(providers: Provider[]): IAgentRuntime {
	return { providers } as unknown as IAgentRuntime;
}

function msg(): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000b2" as UUID,
		entityId: "00000000-0000-0000-0000-0000000000c2" as UUID,
		roomId: "00000000-0000-0000-0000-0000000000d2" as UUID,
		content: { text: "plan it" },
	} as unknown as Memory;
}

function select(
	providers: Provider[],
	selectedContexts: AgentContext[],
): string[] {
	return selectV5PlannerStateProviderNames({
		runtime: makeRuntime(providers),
		message: msg(),
		selectedContexts,
		userRoles: ["MEMBER"],
	});
}

describe("selectV5PlannerStateProviderNames — declared contextGate honored (#13203)", () => {
	const walletGated = provider({
		name: "WALLET_GATED_SIGNAL",
		contextGate: { anyOf: ["wallet"] },
	});

	it("selects a gate-only anyOf provider on its gate turn", () => {
		expect(select([walletGated], ["wallet"])).toContain("WALLET_GATED_SIGNAL");
	});

	it("excludes a gate-only anyOf provider on unrelated turns", () => {
		expect(select([walletGated], ["documents"])).not.toContain(
			"WALLET_GATED_SIGNAL",
		);
		expect(select([walletGated], [])).not.toContain("WALLET_GATED_SIGNAL");
	});

	it("honors noneOf: an active denied context excludes the provider", () => {
		const notInCode = provider({
			name: "NOT_IN_CODE",
			contextGate: { anyOf: ["general"], noneOf: ["code"] },
		});
		expect(select([notInCode], ["general"])).toContain("NOT_IN_CODE");
		expect(select([notInCode], ["general", "code"])).not.toContain(
			"NOT_IN_CODE",
		);
	});

	it("routes undeclared orchestrator providers via the catalog to code/automation turns", () => {
		const availableAgents = provider({
			name: "AVAILABLE_AGENTS",
			dynamic: true,
		});
		const activeSubAgents = provider({
			name: "ACTIVE_SUB_AGENTS",
			dynamic: true,
		});
		const onCodeTurn = select([availableAgents, activeSubAgents], ["code"]);
		expect(onCodeTurn).toContain("AVAILABLE_AGENTS");
		expect(onCodeTurn).toContain("ACTIVE_SUB_AGENTS");

		const onGeneralTurn = select(
			[availableAgents, activeSubAgents],
			["general"],
		);
		expect(onGeneralTurn).not.toContain("AVAILABLE_AGENTS");
		expect(onGeneralTurn).not.toContain("ACTIVE_SUB_AGENTS");
	});

	it("keeps declared-contexts providers on their declared routing (hot-path parity)", () => {
		const declared = provider({
			name: "DECLARED_SIGNAL",
			contexts: ["documents"],
		});
		expect(select([declared], ["documents"])).toContain("DECLARED_SIGNAL");
		expect(select([declared], ["wallet"])).not.toContain("DECLARED_SIGNAL");
	});

	it("composes RECENT_ERRORS on every turn via alwaysInResponseState (#13203)", () => {
		// RECENT_ERRORS is uncataloged and declares no contexts; without the
		// always-on opt-in it would resolve to ["general"] and miss the narrow
		// planner/tool turns where failures matter most.
		expect(recentErrorsProvider.alwaysInResponseState).toBe(true);
		expect(select([recentErrorsProvider], ["code"])).toContain("RECENT_ERRORS");
		expect(select([recentErrorsProvider], [])).toContain("RECENT_ERRORS");
	});
});
