import { describe, expect, test } from "vitest";
import { subAgentCredentialsPlugin } from "./plugin";

describe("subAgentCredentialsPlugin", () => {
	test("registers the four credential-bridge atomic actions", () => {
		expect(subAgentCredentialsPlugin.name).toBe("sub-agent-credentials");
		const actionNames = (subAgentCredentialsPlugin.actions ?? []).map(
			(a) => a.name,
		);
		expect(actionNames).toEqual([
			"DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
			"TUNNEL_CREDENTIAL_TO_CHILD_SESSION",
			"AWAIT_CHILD_AGENT_DECISION",
			"RETRIEVE_CHILD_AGENT_RESULTS",
		]);
	});

	test("does not register any services, providers, or evaluators", () => {
		expect(subAgentCredentialsPlugin.services ?? []).toHaveLength(0);
		expect(subAgentCredentialsPlugin.providers ?? []).toHaveLength(0);
		expect(subAgentCredentialsPlugin.evaluators ?? []).toHaveLength(0);
	});
});
