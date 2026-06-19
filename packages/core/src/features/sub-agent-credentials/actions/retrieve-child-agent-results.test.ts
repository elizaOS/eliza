import { describe, expect, test, vi } from "vitest";
import {
	SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE,
	type SubAgentChildResultsClient,
} from "../types";
import { retrieveChildAgentResultsAction } from "./retrieve-child-agent-results";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("RETRIEVE_CHILD_AGENT_RESULTS", () => {
	test("returns the bundle the client resolves with", async () => {
		const bundle = {
			childSessionId: "pty-1-abc",
			retrievedAt: 1234567890,
			transcript: "ok",
			artifacts: [{ path: "/tmp/out.txt", bytes: 12 }],
		};
		const getResults = vi.fn().mockResolvedValue(bundle);
		const client: SubAgentChildResultsClient = { getResults };

		const result = await retrieveChildAgentResultsAction.handler(
			createRuntime({
				[SUB_AGENT_CHILD_RESULTS_CLIENT_SERVICE]: client,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { childSessionId: "pty-1-abc" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.bundle).toEqual(bundle);
		expect(getResults).toHaveBeenCalledWith({ childSessionId: "pty-1-abc" });
	});

	test("validate fails when results client is missing", async () => {
		const ok = await retrieveChildAgentResultsAction.validate(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{ parameters: { childSessionId: "pty-1-abc" } } as never,
		);
		expect(ok).toBe(false);
	});

	test("missing service surfaces a service-unavailable error", async () => {
		const result = await retrieveChildAgentResultsAction.handler(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{ parameters: { childSessionId: "pty-1-abc" } } as never,
		);
		expect(result.success).toBe(false);
	});
});
