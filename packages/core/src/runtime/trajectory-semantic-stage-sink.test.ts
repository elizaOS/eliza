/**
 * Unit coverage for the semantic-stage fan-out recorder wrapper: it mirrors
 * every recorded stage into the trajectories service keyed by the turn's ALS
 * step id, skips the mirror without a step id or database service, and treats
 * mirror failures as J7 diagnostics (warn + reportError) that never break the
 * inner file write. Deterministic; the recorder, runtime, and service are
 * in-memory fakes.
 */
import { describe, expect, it } from "vitest";
import { runWithTrajectoryContext } from "../trajectory-context";
import type { RecordedStage, TrajectoryRecorder } from "./trajectory-recorder";
import { withSemanticStageFanOut } from "./trajectory-semantic-stage-sink";

const stage: RecordedStage = {
	stageId: "stage-1",
	kind: "toolSearch",
	startedAt: 1,
	endedAt: 2,
	latencyMs: 1,
	toolSearch: {
		query: { candidateActions: ["VIEWS"] },
		results: [{ name: "VIEWS", score: 1, rank: 1 }],
		selectedActions: ["VIEWS"],
	},
};

function createInnerRecorder(recorded: RecordedStage[]): TrajectoryRecorder {
	return {
		startTrajectory: () => "tj-1",
		recordStage: async (_trajectoryId, recordedStage) => {
			recorded.push(recordedStage);
		},
		endTrajectory: async () => undefined,
		load: async () => null,
		list: async () => [],
	};
}

describe("withSemanticStageFanOut", () => {
	it("mirrors recorded stages into the trajectories service under the ALS step id", async () => {
		const recorded: RecordedStage[] = [];
		const mirrored: Array<{ stepId: string; stage: RecordedStage }> = [];
		const recorder = withSemanticStageFanOut(createInnerRecorder(recorded), {
			getService: () => ({
				logSemanticStage: (params: { stepId: string; stage: RecordedStage }) =>
					mirrored.push(params),
			}),
			reportError: () => {
				throw new Error("unexpected reportError");
			},
			logger: {},
		});

		await runWithTrajectoryContext(
			{ trajectoryStepId: "step-42" },
			async () => {
				await recorder.recordStage("tj-1", stage);
			},
		);

		expect(recorded).toHaveLength(1);
		expect(mirrored).toEqual([{ stepId: "step-42", stage }]);
	});

	it("still performs the file write when no step id or database service exists", async () => {
		const recorded: RecordedStage[] = [];
		const recorder = withSemanticStageFanOut(createInnerRecorder(recorded), {
			getService: () => null,
			reportError: () => {
				throw new Error("unexpected reportError");
			},
			logger: {},
		});

		await recorder.recordStage("tj-1", stage);
		await runWithTrajectoryContext(
			{ trajectoryStepId: "step-42" },
			async () => {
				await recorder.recordStage("tj-1", stage);
			},
		);

		expect(recorded).toHaveLength(2);
	});

	it("reports mirror failures as J7 diagnostics without failing the record call", async () => {
		const recorded: RecordedStage[] = [];
		const warned: unknown[] = [];
		const reported: string[] = [];
		const recorder = withSemanticStageFanOut(createInnerRecorder(recorded), {
			getService: () => ({
				logSemanticStage: () => {
					throw new Error("database unavailable");
				},
			}),
			reportError: (scope) => {
				reported.push(scope);
			},
			logger: {
				warn: (context) => {
					warned.push(context);
				},
			},
		});

		await runWithTrajectoryContext(
			{ trajectoryStepId: "step-42" },
			async () => {
				await expect(
					recorder.recordStage("tj-1", stage),
				).resolves.toBeUndefined();
			},
		);

		expect(recorded).toHaveLength(1);
		expect(warned).toHaveLength(1);
		expect(reported).toEqual(["TrajectorySemanticStageSink.recordStage"]);
	});
});
