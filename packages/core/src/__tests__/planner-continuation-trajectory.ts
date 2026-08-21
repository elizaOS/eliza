/**
 * Provides the causal persistence barrier used by planner-continuation
 * evidence after visible message delivery has completed, plus the artifact
 * state machine that turns a live run into its reviewable receipt.
 *
 * The state machine exists because a live run can fail at any of several
 * distinct points — before the harness exists, after it exists but before
 * any case ran, after some but not all cases produced evidence, after every
 * case produced evidence but the test itself still failed, or during
 * teardown — and each of those must render as a visibly different, honestly
 * labeled artifact rather than as `captured` (which previously was asserted
 * from `harness` being merely non-null, so it read as healthy for wrong
 * runs). The artifact is written atomically (temp file + rename in the same
 * directory) so a killed process leaves the last fully-written state (the
 * `started` sentinel written before any case ran, at worst) rather than a
 * half-written or stale file from an earlier run.
 */

import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { drainPostDeliveryTasks } from "../services/post-delivery-task-tracker.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

export interface PlannerContinuationTrajectoryDetail {
	metrics?: { finalStatus?: string };
}

interface PlannerContinuationTrajectoryService<
	TDetail extends PlannerContinuationTrajectoryDetail,
> {
	flushWriteQueue(trajectoryId: string): Promise<void>;
	getTrajectoryDetail(trajectoryId: string): Promise<TDetail | null>;
}

type PlannerContinuationRuntime = Pick<
	IAgentRuntime,
	"agentId" | "reportError"
> &
	Partial<Pick<IAgentRuntime, "roomHandlerQueue">>;

function requireTrajectoryService<
	TDetail extends PlannerContinuationTrajectoryDetail,
>(service: unknown): PlannerContinuationTrajectoryService<TDetail> {
	if (
		typeof service !== "object" ||
		service === null ||
		typeof (service as { flushWriteQueue?: unknown }).flushWriteQueue !==
			"function"
	) {
		throw new Error(
			"Planner continuation trajectory service requires flushWriteQueue(trajectoryId)",
		);
	}
	if (
		typeof (service as { getTrajectoryDetail?: unknown })
			.getTrajectoryDetail !== "function"
	) {
		throw new Error(
			"Planner continuation trajectory service requires getTrajectoryDetail(trajectoryId)",
		);
	}
	return service as PlannerContinuationTrajectoryService<TDetail>;
}

/** Drain terminal work, flush its queued write once, then read one terminal row. */
export async function readCompletedPlannerContinuationTrajectory<
	TDetail extends PlannerContinuationTrajectoryDetail,
>(
	runtime: PlannerContinuationRuntime,
	trajectoryId: string,
	service: unknown,
): Promise<TDetail> {
	if (typeof trajectoryId !== "string" || !trajectoryId.trim()) {
		throw new Error("Planner continuation trajectoryId must be non-empty");
	}
	const trajectoryService = requireTrajectoryService<TDetail>(service);

	await drainPostDeliveryTasks(runtime);
	await trajectoryService.flushWriteQueue(trajectoryId);
	const detail = await trajectoryService.getTrajectoryDetail(trajectoryId);
	if (!detail) {
		throw new Error(
			`Planner continuation trajectory "${trajectoryId}" was not persisted after post-delivery drain`,
		);
	}
	const finalStatus = detail.metrics?.finalStatus;
	if (finalStatus !== "completed") {
		throw new Error(
			`Planner continuation trajectory "${trajectoryId}" is not completed (observed: ${finalStatus ?? "missing"})`,
		);
	}
	return detail;
}

export interface PlannerContinuationEvidenceHarness {
	providerName: string | null;
	providerConfig: {
		baseUrl?: string;
		smallModel?: string;
		largeModel?: string;
	} | null;
}

/**
 * Explicit, incrementally-updated progress for the live run's fixed set of
 * cases. `completedCases` must only be incremented at the moment a case
 * actually records its evidence entry (never inferred from a truthy
 * `harness`, which is assigned long before any case runs).
 */
export interface PlannerContinuationRunProgress {
	totalCases: number;
	completedCases: number;
}

export type PlannerContinuationEvidenceStatus =
	| "started"
	| "captured"
	| "harness-unavailable"
	| "setup-failed"
	| "test-failed"
	| "partial"
	| "cleanup-failed";

export interface PlannerContinuationEvidenceOutcome {
	runId: string;
	harness: PlannerContinuationEvidenceHarness | undefined;
	evidence: ReadonlyArray<Record<string, unknown>>;
	progress: PlannerContinuationRunProgress;
	/** Thrown by `beforeAll` before the harness (or provider validation) completed. */
	setupError?: unknown;
	/** Thrown by the `it` body itself, after setup succeeded. */
	testError?: unknown;
	/** Thrown by teardown (`harness.cleanup()`), after the run's own outcome was decided. */
	cleanupError?: unknown;
	/** Set only for a run that never attempted the harness at all (env flag/key absent). */
	skipped?: { reason: string };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function providerFields(harness: PlannerContinuationEvidenceHarness) {
	return {
		provider: harness.providerName,
		baseUrl: harness.providerConfig?.baseUrl,
		smallModel: harness.providerConfig?.smallModel,
		largeModel: harness.providerConfig?.largeModel,
	};
}

function render(body: Record<string, unknown>): string {
	return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Sentinel written after the harness exists and provider validation and
 * action registration have both succeeded, but before any of the three live
 * cases have run. Its presence (undisturbed) on disk after a killed run is
 * the honest signal that setup finished but no case evidence exists yet —
 * never a leftover `captured` file from a previous run.
 */
export function serializePlannerContinuationEvidenceStarted(
	runId: string,
	harness: PlannerContinuationEvidenceHarness,
): string {
	return render({
		status: "started" satisfies PlannerContinuationEvidenceStatus,
		runId,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		...providerFields(harness),
	});
}

/**
 * Render the terminal live-evidence artifact for one run. `status` is derived
 * from explicit outcome fields only — never from `harness` truthiness alone —
 * so a run that failed after the harness was constructed (wrong-provider
 * rejection, registration failure, a mid-turn failure, or a post-push
 * assertion failure) cannot render as `captured`.
 *
 * Precedence: an explicit `skipped` run wins over everything (the suite never
 * attempted the harness at all); `setupError` wins over `testError` and
 * `cleanupError` (an earlier, more specific failure is never demoted by a
 * later one); `cleanupError` only promotes a would-be `captured` result to
 * `cleanup-failed` — it never overwrites a `partial`/`test-failed` result,
 * because the run's own defect is more specific than teardown breaking
 * afterward.
 */
export function serializePlannerContinuationEvidence(
	outcome: PlannerContinuationEvidenceOutcome,
): string {
	const {
		runId,
		harness,
		evidence,
		progress,
		setupError,
		testError,
		cleanupError,
		skipped,
	} = outcome;
	const base = {
		runId,
		pid: process.pid,
		finishedAt: new Date().toISOString(),
	};

	if (skipped) {
		return render({
			...base,
			status: "harness-unavailable" satisfies PlannerContinuationEvidenceStatus,
			reason: skipped.reason,
			evidence: [],
		});
	}
	if (setupError) {
		return render({
			...base,
			status: "setup-failed" satisfies PlannerContinuationEvidenceStatus,
			reason: errorMessage(setupError),
			evidence,
		});
	}
	if (!harness) {
		return render({
			...base,
			status: "harness-unavailable" satisfies PlannerContinuationEvidenceStatus,
			reason:
				"live continuation harness did not initialize; no provider attribution was observed",
			evidence,
		});
	}

	const allCasesRan =
		progress.totalCases > 0 && progress.completedCases >= progress.totalCases;

	if (testError && !allCasesRan) {
		return render({
			...base,
			status: "partial" satisfies PlannerContinuationEvidenceStatus,
			reason: errorMessage(testError),
			completedCases: progress.completedCases,
			totalCases: progress.totalCases,
			...providerFields(harness),
			evidence,
		});
	}
	if (testError && allCasesRan) {
		return render({
			...base,
			status: "test-failed" satisfies PlannerContinuationEvidenceStatus,
			reason: errorMessage(testError),
			...providerFields(harness),
			evidence,
		});
	}
	if (!allCasesRan) {
		return render({
			...base,
			status: "partial" satisfies PlannerContinuationEvidenceStatus,
			reason: `run ended after ${progress.completedCases}/${progress.totalCases} cases without an observed error`,
			completedCases: progress.completedCases,
			totalCases: progress.totalCases,
			...providerFields(harness),
			evidence,
		});
	}
	if (cleanupError) {
		return render({
			...base,
			status: "cleanup-failed" satisfies PlannerContinuationEvidenceStatus,
			reason: errorMessage(cleanupError),
			...providerFields(harness),
			evidence,
		});
	}
	return render({
		...base,
		status: "captured" satisfies PlannerContinuationEvidenceStatus,
		...providerFields(harness),
		evidence,
	});
}

/**
 * Write `body` to `path` by writing a temp file in the same directory and
 * renaming it over the target. `rename` within one directory is atomic on
 * POSIX and Windows filesystems, so a process killed mid-write leaves either
 * the previous file untouched or the new one complete — never a truncated or
 * half-written artifact.
 */
export async function writePlannerContinuationEvidenceArtifact(
	path: string,
	body: string,
): Promise<void> {
	const dir = dirname(path);
	const tmpPath = join(
		dir,
		`.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
	);
	await writeFile(tmpPath, body);
	await rename(tmpPath, path);
}
