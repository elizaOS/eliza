import { describe, expect, it, vi } from "vitest";
import type { Action, IAgentRuntime, Memory, State } from "../../types";
import {
	MAX_TRAJECTORY_STATE_DEPTH,
	TRAJECTORY_STATE_BOUNDED,
	setTrajectoryContext,
	snapshotStateForTrajectory,
	wrapActionWithLogging,
	wrapProviderWithLogging,
} from "./action-interceptor.ts";
import type { TrajectoriesService } from "./TrajectoriesService.ts";

function nest(depth: number): unknown {
	let value: unknown = "leaf";
	for (let i = 0; i < depth; i += 1) {
		value = { n: value };
	}
	return value;
}

const runtime = { agentId: "00000000-0000-0000-0000-0000000000aa" } as IAgentRuntime;
const message = { content: { text: "hi" } } as Memory;

function mockLogger(): TrajectoriesService {
	return {
		getCurrentStepId: () => "step-1",
		completeStep: vi.fn(),
		logProviderAccess: vi.fn(),
	} as unknown as TrajectoriesService;
}

describe("snapshotStateForTrajectory", () => {
	it("origin JSON.stringify of a cyclic state TypeErrors", () => {
		const cyclic: Record<string, unknown> = { text: "hello" };
		cyclic.self = cyclic;
		expect(() => JSON.parse(JSON.stringify(cyclic))).toThrow(TypeError);
	});

	it("preserves honest state", () => {
		expect(
			snapshotStateForTrajectory({
				values: { k: "v" },
				data: {},
				text: "hello",
			}),
		).toEqual({ values: { k: "v" }, data: {}, text: "hello" });
	});

	it("fail-closes a cycle to the sentinel instead of TypeError", () => {
		const cyclic: Record<string, unknown> = { text: "hello" };
		cyclic.self = cyclic;
		expect(() => JSON.parse(JSON.stringify(cyclic))).toThrow(TypeError);
		const snapped = snapshotStateForTrajectory(cyclic) as Record<string, unknown>;
		expect(snapped.text).toBe("hello");
		expect(snapped.self).toBe(TRAJECTORY_STATE_BOUNDED);
	});

	it(`fail-closes past depth ${MAX_TRAJECTORY_STATE_DEPTH}`, () => {
		const snapped = snapshotStateForTrajectory(
			nest(MAX_TRAJECTORY_STATE_DEPTH + 1),
		) as Record<string, unknown>;
		expect(JSON.stringify(snapped)).toContain(TRAJECTORY_STATE_BOUNDED);
	});
});

describe("wrapActionWithLogging state snapshot", () => {
	it("returns the action result when state is cyclic", async () => {
		const logger = mockLogger();
		setTrajectoryContext(runtime, "traj-1", logger);
		const action = wrapActionWithLogging(
			{
				name: "TEST_ACTION",
				description: "test",
				similes: [],
				examples: [],
				handler: async () => ({ success: true, text: "ok" }),
			} as Action,
			logger,
		);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const state = {
			values: {},
			data: { cyclic },
			text: "",
		} as unknown as State;
		const result = await action.handler?.(runtime, message, state);
		expect(result).toMatchObject({ success: true, text: "ok" });
		expect(logger.completeStep).toHaveBeenCalled();
	});
});

describe("wrapProviderWithLogging state snapshot", () => {
	it("returns provider text when state is cyclic", async () => {
		const logger = mockLogger();
		setTrajectoryContext(runtime, "traj-2", logger);
		const provider = wrapProviderWithLogging(
			{
				name: "TEST_PROVIDER",
				description: "test",
				get: async () => ({ text: "ctx" }),
			},
			logger,
		);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const state = {
			values: {},
			data: { cyclic },
			text: "",
		} as unknown as State;
		const result = await provider.get(runtime, message, state);
		expect(result.text).toBe("ctx");
		expect(logger.logProviderAccess).toHaveBeenCalled();
	});
});
