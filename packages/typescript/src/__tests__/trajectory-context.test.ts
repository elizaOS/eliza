import { describe, expect, it } from "vitest";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../trajectory-context";

describe("Trajectory Context", () => {
	it("context is available immediately on first access (no async init race)", () => {
		// This is the bug this fix addresses: the old lazy async init meant
		// the first few calls used StackContextManager which doesn't propagate
		// through async/await. With synchronous init, AsyncLocalStorage is
		// available immediately.
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
				// Simulate async work (provider loading, state composition, etc.)
				await new Promise((r) => setTimeout(r, 10));
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
				await new Promise((r) => setTimeout(r, 5));
				// Simulates useModel being called after several awaits
				const doInnerWork = async () => {
					await new Promise((r) => setTimeout(r, 5));
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
				await new Promise((r) => setTimeout(r, 20));
				const ctx = getTrajectoryContext();
				results.push(ctx?.trajectoryStepId ?? "missing");
			}),
			runWithTrajectoryContext({ trajectoryStepId: "call-B" }, async () => {
				await new Promise((r) => setTimeout(r, 10));
				const ctx = getTrajectoryContext();
				results.push(ctx?.trajectoryStepId ?? "missing");
			}),
		]);

		expect(results).toContain("call-A");
		expect(results).toContain("call-B");
		expect(results).not.toContain("missing");
	});
});
