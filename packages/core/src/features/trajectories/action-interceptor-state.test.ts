import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger";
import type { Action, IAgentRuntime, Memory, State } from "../../types";
import {
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

const runtime = {
	agentId: "00000000-0000-0000-0000-0000000000aa",
} as IAgentRuntime;
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

	it("fail-closes a cycle to [Circular] instead of TypeError", () => {
		const cyclic: Record<string, unknown> = { text: "hello" };
		cyclic.self = cyclic;
		expect(() => JSON.parse(JSON.stringify(cyclic))).toThrow(TypeError);
		const snapped = snapshotStateForTrajectory(cyclic) as Record<
			string,
			unknown
		>;
		expect(snapped.text).toBe("hello");
		expect(snapped.self).toBe("[Circular]");
	});

	it("fail-closes past the sanitizer depth to [MaxDepth]", () => {
		const snapped = snapshotStateForTrajectory(nest(21)) as Record<
			string,
			unknown
		>;
		expect(JSON.stringify(snapped)).toContain("[MaxDepth]");
	});

	it("keeps an honest shared-reference DAG", () => {
		const shared = { k: "v" };
		expect(
			snapshotStateForTrajectory({
				values: { ref: shared },
				data: { ref: shared },
			}),
		).toEqual({
			values: { ref: { k: "v" } },
			data: { ref: { k: "v" } },
		});
	});

	it("coerces Date leaves to ISO", () => {
		expect(
			snapshotStateForTrajectory({
				seenAt: new Date("2026-08-20T00:00:00.000Z"),
			}),
		).toEqual({ seenAt: "2026-08-20T00:00:00.000Z" });
	});

	it("degrades a throwing getter to null instead of throwing", () => {
		const poisoned = {
			get boom() {
				throw new Error("getter");
			},
		};
		expect(snapshotStateForTrajectory(poisoned)).toBeNull();
	});

	it("warns when a throwing getter degrades the snapshot", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			const poisoned = {
				get boom() {
					throw new Error("getter");
				},
			};
			expect(snapshotStateForTrajectory(poisoned)).toBeNull();
			expect(warn).toHaveBeenCalled();
			expect(String(warn.mock.calls[0]?.[0])).toMatch(
				/state snapshot degraded to null/,
			);
		} finally {
			warn.mockRestore();
		}
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

	it("returns the action result when a state getter throws", async () => {
		const logger = mockLogger();
		setTrajectoryContext(runtime, "traj-poison", logger);
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
		const state = {
			values: {},
			data: {
				get boom() {
					throw new Error("getter");
				},
			},
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
