import { describe, expect, test, vi } from "vitest";
import {
	SUB_AGENT_CHILD_DECISION_BUS_SERVICE,
	type SubAgentChildDecisionBus,
} from "../types";
import { awaitChildAgentDecisionAction } from "./await-child-agent-decision";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("AWAIT_CHILD_AGENT_DECISION", () => {
	test("returns the decision the bus resolves with", async () => {
		const decision = {
			childSessionId: "pty-1-abc",
			decidedAt: 1234567890,
			decision: "DECISION: abort",
		};
		const awaitDecision = vi.fn().mockResolvedValue(decision);
		const bus: SubAgentChildDecisionBus = { awaitDecision };

		const result = await awaitChildAgentDecisionAction.handler(
			createRuntime({
				[SUB_AGENT_CHILD_DECISION_BUS_SERVICE]: bus,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { childSessionId: "pty-1-abc" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.decision).toEqual(decision);
		expect(awaitDecision).toHaveBeenCalledWith({
			childSessionId: "pty-1-abc",
			timeoutMs: 600000,
		});
	});

	test("honors a custom timeoutMs", async () => {
		const awaitDecision = vi.fn().mockResolvedValue({
			childSessionId: "pty-1-abc",
			decidedAt: 0,
			decision: "x",
		});
		const bus: SubAgentChildDecisionBus = { awaitDecision };

		await awaitChildAgentDecisionAction.handler(
			createRuntime({
				[SUB_AGENT_CHILD_DECISION_BUS_SERVICE]: bus,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { childSessionId: "pty-1-abc", timeoutMs: 5000 },
			} as never,
		);

		expect(awaitDecision).toHaveBeenCalledWith({
			childSessionId: "pty-1-abc",
			timeoutMs: 5000,
		});
	});

	test("validate fails without childSessionId", async () => {
		const bus: SubAgentChildDecisionBus = { awaitDecision: vi.fn() };
		const ok = await awaitChildAgentDecisionAction.validate(
			createRuntime({
				[SUB_AGENT_CHILD_DECISION_BUS_SERVICE]: bus,
			}) as never,
			message() as never,
			undefined,
			{ parameters: {} } as never,
		);
		expect(ok).toBe(false);
	});
});
