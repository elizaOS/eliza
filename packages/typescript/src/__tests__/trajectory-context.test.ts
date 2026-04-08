import { describe, expect, it } from "vitest";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../trajectory-context";

describe("trajectory context", () => {
	it("context is available immediately on first access (no async init race)", () => {
		let captured: { trajectoryStepId?: string } | undefined;

		runWithTrajectoryContext({ trajectoryStepId: "test-step-1" }, () => {
			captured = getTrajectoryContext();
		});

		expect(captured).toBeDefined();
		expect(captured?.trajectoryStepId).toBe("test-step-1");
	});

	it("propagates context through async/await", async () => {
		let captured: { trajectoryStepId?: string } | undefined;

		await runWithTrajectoryContext(
			{ trajectoryStepId: "async-step" },
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				captured = getTrajectoryContext();
			},
		);

		expect(captured).toBeDefined();
		expect(captured?.trajectoryStepId).toBe("async-step");
	});

	it("propagates through nested async calls", async () => {
		let innerCapture: { trajectoryStepId?: string } | undefined;

		await runWithTrajectoryContext(
			{ trajectoryStepId: "outer-step" },
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				const doInnerWork = async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					innerCapture = getTrajectoryContext();
				};
				await doInnerWork();
			},
		);

		expect(innerCapture).toBeDefined();
		expect(innerCapture?.trajectoryStepId).toBe("outer-step");
	});

	it("returns undefined when no context is set", () => {
		expect(getTrajectoryContext()).toBeUndefined();
	});

	it("isolates contexts between concurrent calls", async () => {
		const results: string[] = [];

		await Promise.all([
			runWithTrajectoryContext({ trajectoryStepId: "call-A" }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				const ctx = getTrajectoryContext();
				results.push(ctx?.trajectoryStepId ?? "missing");
			}),
			runWithTrajectoryContext({ trajectoryStepId: "call-B" }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				const ctx = getTrajectoryContext();
				results.push(ctx?.trajectoryStepId ?? "missing");
			}),
		]);

		expect(results).toContain("call-A");
		expect(results).toContain("call-B");
		expect(results).not.toContain("missing");
	});

	it("shares the context manager across separate module instances", async () => {
		const moduleA = await import("../trajectory-context?instance=a");
		const moduleB = await import("../trajectory-context?instance=b");

		const manager = {
			run: <T>(
				_context: { trajectoryStepId?: string } | undefined,
				fn: () => T | Promise<T>,
			): T | Promise<T> => fn(),
			active: () => ({ trajectoryStepId: "shared-step" }),
		};

		moduleA.setTrajectoryContextManager(manager);

		expect(moduleB.getTrajectoryContextManager()).toBe(manager);
		expect(moduleB.getTrajectoryContext()).toEqual({
			trajectoryStepId: "shared-step",
		});
	});
});
