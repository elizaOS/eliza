/**
 * Exercises the planner-continuation evidence barrier with the real
 * post-delivery tracker and deterministic delayed and nested terminal work,
 * plus every transition of the live-evidence artifact state machine using
 * a real filesystem (tmp dir) for the atomic-write assertions.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `rename` cannot be spied on directly (Node's ESM builtins have a
// non-configurable module namespace), so the mid-rename interruption case
// below needs a real mock declared at module scope. `failNextRename` is
// flipped on by exactly the one test that needs it; every other call passes
// straight through to the real implementation.
let failNextRename = false;
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
			if (failNextRename) {
				failNextRename = false;
				throw new Error("process killed mid-rename");
			}
			return actual.rename(...args);
		}),
	};
});

import {
	drainPostDeliveryTasks,
	trackPostDeliveryTask,
} from "../services/post-delivery-task-tracker.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	type PlannerContinuationTrajectoryDetail,
	readCompletedPlannerContinuationTrajectory,
	serializePlannerContinuationEvidence,
	serializePlannerContinuationEvidenceStarted,
	writePlannerContinuationEvidenceArtifact,
} from "./planner-continuation-trajectory.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function runtimeStub(): Pick<IAgentRuntime, "agentId" | "reportError"> {
	return {
		agentId: "00000000-0000-4000-8000-000000000045",
		reportError: vi.fn(),
	};
}

function trajectoryService(
	readDetail: () => PlannerContinuationTrajectoryDetail | null,
) {
	const calls: string[] = [];
	return {
		calls,
		flushWriteQueue: vi.fn(async (trajectoryId: string) => {
			calls.push(`flush:${trajectoryId}`);
		}),
		getTrajectoryDetail: vi.fn(async (trajectoryId: string) => {
			calls.push(`read:${trajectoryId}`);
			return readDetail();
		}),
	};
}

describe("planner continuation trajectory persistence barrier", () => {
	it("waits for delayed terminalization before one flush and one read", async () => {
		const runtime = runtimeStub();
		const terminalGate = deferred();
		const taskStarted = deferred();
		let detail: PlannerContinuationTrajectoryDetail = {
			metrics: { finalStatus: "active" },
		};
		trackPostDeliveryTask(runtime, "delayed-terminal", async () => {
			taskStarted.resolve();
			await terminalGate.promise;
			detail = { metrics: { finalStatus: "completed" } };
		});
		const service = trajectoryService(() => detail);

		const read = readCompletedPlannerContinuationTrajectory(
			runtime,
			"trajectory-delayed",
			service,
		);
		await taskStarted.promise;
		expect(service.flushWriteQueue).not.toHaveBeenCalled();
		expect(service.getTrajectoryDetail).not.toHaveBeenCalled();

		terminalGate.resolve();
		await expect(read).resolves.toEqual({
			metrics: { finalStatus: "completed" },
		});
		expect(service.flushWriteQueue).toHaveBeenCalledOnce();
		expect(service.flushWriteQueue).toHaveBeenCalledWith("trajectory-delayed");
		expect(service.getTrajectoryDetail).toHaveBeenCalledOnce();
		expect(service.getTrajectoryDetail).toHaveBeenCalledWith(
			"trajectory-delayed",
		);
		expect(service.calls).toEqual([
			"flush:trajectory-delayed",
			"read:trajectory-delayed",
		]);
	});

	it("drains separately gated nested tracked work before persistence", async () => {
		const runtime = runtimeStub();
		const nestedGate = deferred();
		const nestedStarted = deferred();
		let detail: PlannerContinuationTrajectoryDetail = {
			metrics: { finalStatus: "active" },
		};
		const outer = trackPostDeliveryTask(runtime, "outer-terminal", async () => {
			trackPostDeliveryTask(runtime, "nested-terminal", async () => {
				nestedStarted.resolve();
				await nestedGate.promise;
				detail = { metrics: { finalStatus: "completed" } };
			});
		});
		const service = trajectoryService(() => detail);
		const read = readCompletedPlannerContinuationTrajectory(
			runtime,
			"trajectory-nested",
			service,
		);

		await nestedStarted.promise;
		await outer;
		expect(service.flushWriteQueue).not.toHaveBeenCalled();
		expect(service.getTrajectoryDetail).not.toHaveBeenCalled();

		nestedGate.resolve();
		await expect(read).resolves.toEqual({
			metrics: { finalStatus: "completed" },
		});
		expect(service.flushWriteQueue).toHaveBeenCalledTimes(1);
		expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(1);
		await expect(drainPostDeliveryTasks(runtime)).resolves.toBe(0);
	});

	it("rejects a missing detail after exactly one flush and one read", async () => {
		const runtime = runtimeStub();
		const service = trajectoryService(() => null);

		await expect(
			readCompletedPlannerContinuationTrajectory(
				runtime,
				"trajectory-missing",
				service,
			),
		).rejects.toThrow('trajectory "trajectory-missing" was not persisted');
		expect(service.flushWriteQueue).toHaveBeenCalledTimes(1);
		expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(1);
	});

	it("rejects a nonterminal detail and names its observed status", async () => {
		const runtime = runtimeStub();
		const service = trajectoryService(() => ({
			metrics: { finalStatus: "active" },
		}));

		await expect(
			readCompletedPlannerContinuationTrajectory(
				runtime,
				"trajectory-active",
				service,
			),
		).rejects.toThrow(
			'trajectory "trajectory-active" is not completed (observed: active)',
		);
		expect(service.flushWriteQueue).toHaveBeenCalledTimes(1);
		expect(service.getTrajectoryDetail).toHaveBeenCalledTimes(1);
	});

	it("rejects blank ids and incomplete trajectory services as harness errors", async () => {
		const runtime = runtimeStub();
		const completeService = trajectoryService(() => ({
			metrics: { finalStatus: "completed" },
		}));

		await expect(
			readCompletedPlannerContinuationTrajectory(
				runtime,
				"  ",
				completeService,
			),
		).rejects.toThrow("trajectoryId must be non-empty");
		await expect(
			readCompletedPlannerContinuationTrajectory(runtime, "trajectory-id", {
				getTrajectoryDetail: completeService.getTrajectoryDetail,
			}),
		).rejects.toThrow("requires flushWriteQueue");
		await expect(
			readCompletedPlannerContinuationTrajectory(runtime, "trajectory-id", {
				flushWriteQueue: completeService.flushWriteQueue,
			}),
		).rejects.toThrow("requires getTrajectoryDetail");
		expect(completeService.flushWriteQueue).not.toHaveBeenCalled();
		expect(completeService.getTrajectoryDetail).not.toHaveBeenCalled();
	});
});

const harnessFixture = {
	providerName: "openai",
	providerConfig: {
		baseUrl: "https://api.cerebras.ai/v1",
		smallModel: "small-model",
		largeModel: "large-model",
	},
};

describe("planner continuation evidence artifact state machine", () => {
	it("captures only when the harness exists, no error was observed, and every case completed", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-1",
				harness: harnessFixture,
				evidence: [{ caseName: "directive", executed: true }],
				progress: { totalCases: 1, completedCases: 1 },
			}),
		);

		expect(artifact).toMatchObject({
			status: "captured",
			runId: "run-1",
			provider: "openai",
			baseUrl: "https://api.cerebras.ai/v1",
			smallModel: "small-model",
			largeModel: "large-model",
			evidence: [{ caseName: "directive", executed: true }],
		});
	});

	it("never claims captured from a truthy harness alone — zero completed cases is setup-adjacent, not captured", () => {
		// This is the regression this PR fixes: on develop, `status: "captured"`
		// was asserted merely because `harness` was a non-null object, which is
		// assigned in beforeAll before any case has run.
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-2",
				harness: harnessFixture,
				evidence: [],
				progress: { totalCases: 3, completedCases: 0 },
			}),
		);

		expect(artifact.status).not.toBe("captured");
		expect(artifact.status).toBe("partial");
		expect(artifact.completedCases).toBe(0);
		expect(artifact.totalCases).toBe(3);
	});

	it("marks the artifact harness-unavailable when the harness never initialized and no error was observed", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-3",
				harness: undefined,
				evidence: [],
				progress: { totalCases: 3, completedCases: 0 },
			}),
		);

		expect(artifact.status).toBe("harness-unavailable");
		expect(artifact.provider).toBeUndefined();
		expect(artifact.evidence).toEqual([]);
		expect(String(artifact.reason)).toContain("did not initialize");
	});

	it("marks a skipped run harness-unavailable, never captured, even when an output path was requested", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-skip",
				harness: harnessFixture,
				evidence: [],
				progress: { totalCases: 0, completedCases: 0 },
				skipped: { reason: "live suite skipped: flags not set" },
			}),
		);

		expect(artifact.status).toBe("harness-unavailable");
		expect(artifact.status).not.toBe("captured");
		expect(artifact.reason).toBe("live suite skipped: flags not set");
		expect(artifact.evidence).toEqual([]);
	});

	it("marks setup-failed when beforeAll threw, regardless of harness state", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-4",
				harness: undefined,
				evidence: [],
				progress: { totalCases: 3, completedCases: 0 },
				setupError: new Error("wrong provider selected"),
			}),
		);

		expect(artifact.status).toBe("setup-failed");
		expect(artifact.reason).toBe("wrong provider selected");
	});

	it("marks partial when a case fails after exactly one earlier case pushed evidence", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-5",
				harness: harnessFixture,
				evidence: [{ caseName: "directive", executed: true }],
				progress: { totalCases: 3, completedCases: 1 },
				testError: new Error("approval-after-stop: shellToolCalls was 0"),
			}),
		);

		expect(artifact.status).toBe("partial");
		expect(artifact.completedCases).toBe(1);
		expect(artifact.totalCases).toBe(3);
		expect(artifact.reason).toBe("approval-after-stop: shellToolCalls was 0");
		expect(artifact.evidence).toEqual([
			{ caseName: "directive", executed: true },
		]);
	});

	it("marks test-failed (not partial) when all cases pushed evidence but the test still threw", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-6",
				harness: harnessFixture,
				evidence: [
					{ caseName: "directive", executed: true },
					{ caseName: "approval-after-stop", executed: true },
					{ caseName: "topic-switch", executed: true },
				],
				progress: { totalCases: 3, completedCases: 3 },
				testError: new Error("topic-switch: webToolCalls was 0"),
			}),
		);

		expect(artifact.status).toBe("test-failed");
		expect(artifact.status).not.toBe("partial");
		expect(artifact.reason).toBe("topic-switch: webToolCalls was 0");
		expect(artifact.evidence).toHaveLength(3);
	});

	it("promotes a clean run to cleanup-failed when teardown throws afterward", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-7",
				harness: harnessFixture,
				evidence: [{ caseName: "directive", executed: true }],
				progress: { totalCases: 1, completedCases: 1 },
				cleanupError: new Error("pglite teardown timed out"),
			}),
		);

		expect(artifact.status).toBe("cleanup-failed");
		expect(artifact.reason).toBe("pglite teardown timed out");
	});

	it("keeps the more specific run failure instead of demoting it to cleanup-failed", () => {
		const artifact = JSON.parse(
			serializePlannerContinuationEvidence({
				runId: "run-8",
				harness: harnessFixture,
				evidence: [{ caseName: "directive", executed: true }],
				progress: { totalCases: 3, completedCases: 1 },
				testError: new Error("approval-after-stop: shellToolCalls was 0"),
				cleanupError: new Error("pglite teardown timed out"),
			}),
		);

		expect(artifact.status).toBe("partial");
		expect(artifact.reason).toBe("approval-after-stop: shellToolCalls was 0");
	});

	it("never throws while serializing, so a real setup failure stays the only failure", () => {
		expect(() =>
			serializePlannerContinuationEvidence({
				runId: "run-9",
				harness: undefined,
				evidence: [],
				progress: { totalCases: 3, completedCases: 0 },
				setupError: new Error("boom"),
			}),
		).not.toThrow();
	});
});

describe("planner continuation evidence artifact — atomic write to disk", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "planner-continuation-evidence-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes the started sentinel directly and it is fully readable", async () => {
		const target = join(dir, "evidence.json");
		await writePlannerContinuationEvidenceArtifact(
			target,
			serializePlannerContinuationEvidenceStarted(
				"run-started",
				harnessFixture,
			),
		);

		const written = JSON.parse(await readFile(target, "utf8"));
		expect(written.status).toBe("started");
		expect(written.runId).toBe("run-started");
		expect(written.provider).toBe("openai");
	});

	it("replaces a started sentinel with the captured artifact on a clean run", async () => {
		const target = join(dir, "evidence.json");
		await writePlannerContinuationEvidenceArtifact(
			target,
			serializePlannerContinuationEvidenceStarted(
				"run-replace",
				harnessFixture,
			),
		);
		await writePlannerContinuationEvidenceArtifact(
			target,
			serializePlannerContinuationEvidence({
				runId: "run-replace",
				harness: harnessFixture,
				evidence: [{ caseName: "directive", executed: true }],
				progress: { totalCases: 1, completedCases: 1 },
			}),
		);

		const written = JSON.parse(await readFile(target, "utf8"));
		expect(written.status).toBe("captured");
	});

	it("leaves the started sentinel in place when the terminal write is interrupted", async () => {
		const target = join(dir, "evidence.json");
		await writePlannerContinuationEvidenceArtifact(
			target,
			serializePlannerContinuationEvidenceStarted(
				"run-interrupted",
				harnessFixture,
			),
		);
		const beforeInterrupt = await readFile(target, "utf8");

		// Simulate the process dying between the temp-file write and the rename
		// that publishes it — the step writePlannerContinuationEvidenceArtifact
		// performs atomically. Failing exactly the next `rename` call stands in
		// for that interruption: the temp file gets written, but the publish
		// (rename) step never completes, so the previously-published file must
		// be untouched.
		failNextRename = true;
		await expect(
			writePlannerContinuationEvidenceArtifact(
				target,
				serializePlannerContinuationEvidence({
					runId: "run-interrupted",
					harness: harnessFixture,
					evidence: [{ caseName: "directive", executed: true }],
					progress: { totalCases: 3, completedCases: 1 },
				}),
			),
		).rejects.toThrow("process killed mid-rename");

		const afterInterrupt = await readFile(target, "utf8");
		expect(afterInterrupt).toBe(beforeInterrupt);
		expect(JSON.parse(afterInterrupt).status).toBe("started");
	});

	it("never leaves a stray temp file behind after a successful write", async () => {
		const target = join(dir, "evidence.json");
		await writePlannerContinuationEvidenceArtifact(
			target,
			serializePlannerContinuationEvidenceStarted(randomUUID(), harnessFixture),
		);

		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(dir);
		expect(entries).toEqual(["evidence.json"]);
	});
});
