/**
 * Exercises consecutive autonomy actions through the shared executor so raw
 * planner observations cannot enter a later action's previous-results context.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { Action, Memory, State, UUID } from "../../types";
import { runAutonomyPostResponse } from "./execution-facade";

describe("runAutonomyPostResponse action context", () => {
	it("omits planner observations from the next autonomy action", async () => {
		const observation = "autonomy planner-only observation";
		const first: Action = {
			name: "FIRST",
			description: "First autonomy step",
			validate: async () => true,
			handler: async () => ({ success: true, plannerObservation: observation }),
		};
		const secondHandler = vi.fn(async (_runtime, _message, _state, options) => {
			expect(options?.actionContext?.previousResults).toHaveLength(1);
			expect(
				JSON.stringify(options?.actionContext?.previousResults),
			).not.toContain(observation);
			return { success: true };
		});
		const second: Action = {
			name: "SECOND",
			description: "Second autonomy step",
			validate: async () => true,
			handler: secondHandler,
		};
		const runtime = createMockRuntime({
			actions: [first, second],
			composeState: vi.fn(
				async () => ({ values: {}, data: {}, text: "" }) as State,
			),
			createMemory: vi.fn(async (memory) => memory.id as UUID),
			getRoom: vi.fn(async () => null),
			getService: vi.fn(() => null),
			getServiceLoadPromise: vi.fn(async () => {
				throw new Error("Evaluator service unavailable in unit harness");
			}),
			runActionsByMode: vi.fn(async () => []),
			logger: {
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
			} as never,
		});
		const message = {
			id: "00000000-0000-0000-0000-000000000001" as UUID,
			entityId: runtime.agentId,
			roomId: "00000000-0000-0000-0000-000000000002" as UUID,
			content: { text: "continue autonomous work" },
		} as Memory;

		await runAutonomyPostResponse(runtime, message, {
			actions: ["FIRST", "SECOND"],
			text: "",
		});

		expect(secondHandler).toHaveBeenCalledTimes(1);
	});
});
