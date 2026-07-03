import { describe, expect, it } from "vitest";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
	runWithTrajectoryPurpose,
} from "../trajectory-context";

describe("runWithTrajectoryPurpose", () => {
	it("overrides purpose while preserving the active context fields", async () => {
		await runWithTrajectoryContext(
			{
				trajectoryId: "traj-1",
				trajectoryStepId: "step-1",
				runId: "run-1",
				roomId: "room-1",
				purpose: "action",
			},
			async () => {
				await runWithTrajectoryPurpose("inbox_triage", async () => {
					const ctx = getTrajectoryContext();
					expect(ctx).toMatchObject({
						trajectoryId: "traj-1",
						trajectoryStepId: "step-1",
						runId: "run-1",
						roomId: "room-1",
						purpose: "inbox_triage",
					});
				});
				// Outer context is untouched after the scoped run.
				expect(getTrajectoryContext()?.purpose).toBe("action");
				expect(getTrajectoryContext()?.trajectoryStepId).toBe("step-1");
			},
		);
	});

	it("sets a bare purpose context when no context is active", async () => {
		expect(getTrajectoryContext()).toBeUndefined();
		await runWithTrajectoryPurpose("inbox_triage", async () => {
			const ctx = getTrajectoryContext();
			expect(ctx?.purpose).toBe("inbox_triage");
			expect(ctx?.trajectoryStepId).toBeUndefined();
		});
	});

	it("regression: a bare { purpose } context passed to runWithTrajectoryContext drops the step id", async () => {
		// This is the clobber shape runWithTrajectoryPurpose exists to replace —
		// keep it pinned so the difference stays visible.
		await runWithTrajectoryContext(
			{ trajectoryStepId: "step-1", purpose: "action" },
			async () => {
				await runWithTrajectoryContext(
					{ purpose: "inbox_triage" },
					async () => {
						expect(getTrajectoryContext()?.trajectoryStepId).toBeUndefined();
					},
				);
			},
		);
	});
});
