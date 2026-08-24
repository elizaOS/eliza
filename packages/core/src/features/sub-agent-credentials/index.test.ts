/**
 * Covers the public entry barrel of the sub-agent-credentials feature as
 * consumers see it through `@elizaos/core`: the default export aliases the
 * named plugin, each re-exported atomic action is the exact instance the
 * plugin registers, every action resolves its collaborator under the service
 * name this module exports for it, and the exported service-name constants
 * stay registry-safe (non-empty, pairwise distinct). Handlers run against a
 * recording runtime stub that serves no services, so the lookup contract is
 * observed deterministically — no real bridge, bus, or child process.
 */
import { describe, expect, test } from "vitest";
import * as entry from "./index";

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("features/sub-agent-credentials public entry", () => {
	test("default export aliases the named subAgentCredentialsPlugin", () => {
		expect(entry.default).toBe(entry.subAgentCredentialsPlugin);
	});

	test("re-exported atomic actions are the instances the plugin registers", () => {
		const registered = new Map(
			(entry.subAgentCredentialsPlugin.actions ?? []).map((a) => [a.name, a]),
		);
		const reexported = [
			entry.declareSubAgentCredentialScopeAction,
			entry.tunnelCredentialToChildSessionAction,
			entry.awaitChildAgentDecisionAction,
			entry.retrieveChildAgentResultsAction,
		];
		expect(registered.size).toBe(reexported.length);
		for (const action of reexported) {
			expect(registered.get(action.name)).toBe(action);
		}
	});

	test("every action resolves its collaborator under the constant this module exports", async () => {
		const cases = [
			{
				action: entry.declareSubAgentCredentialScopeAction,
				service: entry.SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
			},
			{
				action: entry.tunnelCredentialToChildSessionAction,
				service: entry.SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
			},
			{
				action: entry.awaitChildAgentDecisionAction,
				service: entry.SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
			},
			{
				action: entry.retrieveChildAgentResultsAction,
				service: entry.SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
			},
		];
		for (const { action, service } of cases) {
			const asked: string[] = [];
			const runtime = {
				getService: (name: string) => {
					asked.push(name);
					return null;
				},
			};
			const result = await action.handler(
				runtime as never,
				message() as never,
				undefined,
				undefined,
			);
			expect(result.success).toBe(false);
			expect(asked).toEqual([service]);
		}
	});

	test("service-name constants are non-empty and pairwise distinct", () => {
		const names = [
			entry.SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
			entry.SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
			entry.SUB_AGENT_CREDENTIAL_PARENT_CAPABILITY_SERVICE,
			entry.SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
			entry.SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
		];
		expect(names.length).toBe(5);
		for (const name of names) {
			expect(name.length).toBeGreaterThan(0);
		}
		expect(new Set(names).size).toBe(names.length);
	});
});
