import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../runtime";
import type { Action, Memory, State, UUID } from "../../types";

function makeMessage(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "message-id" as UUID,
		entityId: "user-id" as UUID,
		roomId: "room-id" as UUID,
		content: { text: "run owner action" },
		...overrides,
	} as Memory;
}

describe("AgentRuntime.processActions role gates", () => {
	it("does not invoke a hallucinated role-gated action for a lower role", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action: Action = {
			name: "OWNER_ONLY",
			description: "Owner-only action",
			roleGate: { minRole: "OWNER" },
			validate: async () => true,
			handler,
		};
		const createMemory = vi.fn(async () => undefined);
		const runtime = {
			agentId: "agent-id",
			actions: [action],
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				trace: vi.fn(),
				warn: vi.fn(),
			},
			isActionPlanningEnabled: () => false,
			getCurrentRunId: () => undefined,
			createRunId: () => "run-id",
			resolveProcessActionUserRoles: vi.fn(async () => ["USER"]),
			composeState: vi.fn(async () => ({ data: {} }) as State),
			createMemory,
			stateCache: { set: vi.fn() },
		};

		await AgentRuntime.prototype.processActions.call(runtime, makeMessage(), [
			makeMessage({
				content: { text: "doing it", actions: ["OWNER_ONLY"] },
			}),
		]);

		expect(handler).not.toHaveBeenCalled();
		expect(createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					actionName: "OWNER_ONLY",
					actionStatus: "failed",
				}),
			}),
			"messages",
		);
	});
});
