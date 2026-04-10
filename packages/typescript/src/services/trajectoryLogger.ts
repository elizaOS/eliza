import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";
import type {
	LlmObservationRecord,
	ProviderObservationRecord,
} from "../optimization/types.ts";
import { TRAJECTORY_PROVIDER_SLOT } from "../optimization/types.ts";
import {
	isTrajectoryCaptureEnabled,
	isTrajectoryHistoryJsonlEnabled,
} from "../trajectory-settings.ts";

export type TrajectoryScalar = string | number | boolean | null;
export type TrajectoryData = Record<string, TrajectoryScalar>;

export type TrajectoryProviderAccess = {
	stepId: string;
	providerName: string;
	purpose: string;
	data: TrajectoryData;
	query?: TrajectoryData;
	timestamp: number;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
};

export type TrajectoryLlmCall = {
	stepId: string;
	model: string;
	systemPrompt: string;
	userPrompt: string;
	response: string;
	temperature: number;
	maxTokens: number;
	purpose: string;
	actionType: string;
	latencyMs: number;
	timestamp: number;
	modelSlot?: string;
	runId?: string;
	roomId?: string;
	messageId?: string;
	executionTraceId?: string;
};

/**
 * Trajectory logger: in-memory capture for harnesses; optional append to `history.jsonl`.
 *
 * **Why in-memory by default:** Tests and benchmarks read logs synchronously from
 * `get*Logs()` without configuring disk. **Why optional JSONL:** Same `TraceWriter`
 * and directory layout as prompt optimization (`OPTIMIZATION_DIR`) so operators
 * get one portable tree — not because raw telemetry is semantically “training data.”
 *
 * **Why dynamic `import("../optimization/index")` for disk:** Static import would
 * pull Node `fs` (via `TraceWriter`) into bundles that include this service for
 * browser targets; disk append is opt-in and rare.
 *
 * Settings: `TRAJECTORY_CAPTURE_ENABLED` (master), `TRAJECTORY_HISTORY_JSONL` (disk).
 * Independent of `PROMPT_OPTIMIZATION_ENABLED`.
 */
export class TrajectoryLoggerService extends Service {
	static serviceType = "trajectory_logger";
	capabilityDescription =
		"Captures provider/LLM traces for benchmarks and training trajectories";

	private providerAccess: TrajectoryProviderAccess[] = [];
	private llmCalls: TrajectoryLlmCall[] = [];

	static async start(runtime: IAgentRuntime): Promise<Service> {
		return new TrajectoryLoggerService(runtime);
	}

	async stop(): Promise<void> {
		// no-op (in-memory logs)
	}

	private getSetting(key: string): unknown {
		return this.runtime.getSetting?.(key);
	}

	private resolveDiskModelId(logicalSlot: string): string {
		const rt = this.runtime as IAgentRuntime & {
			resolveProviderModelString?: (
				resolvedModelType: string,
				optionsModel?: string,
			) => string;
		};
		if (typeof rt.resolveProviderModelString === "function") {
			return rt.resolveProviderModelString(logicalSlot);
		}
		return logicalSlot;
	}

	logProviderAccess(params: {
		stepId: string;
		providerName: string;
		data: TrajectoryData;
		purpose: string;
		query?: TrajectoryData;
		runId?: string;
		roomId?: string;
		messageId?: string;
		executionTraceId?: string;
	}): void {
		if (!isTrajectoryCaptureEnabled((k) => this.getSetting(k))) return;

		const entry: TrajectoryProviderAccess = {
			...params,
			timestamp: Date.now(),
		};
		this.providerAccess.push(entry);

		if (!isTrajectoryHistoryJsonlEnabled((k) => this.getSetting(k))) return;

		const optDirSetting = this.getSetting("OPTIMIZATION_DIR") as string | null;
		const modelId = this.resolveDiskModelId("TEXT_LARGE");
		const row: ProviderObservationRecord = {
			type: "provider_observation",
			observationVersion: 1,
			createdAt: entry.timestamp,
			stepId: params.stepId,
			providerName: params.providerName,
			purpose: params.purpose,
			data: params.data,
			query: params.query,
			runId: params.runId,
			roomId: params.roomId,
			messageId: params.messageId,
			executionTraceId: params.executionTraceId,
		};
		void import("../optimization/index.ts")
			.then(({ getOptimizationRootDir, getTraceWriter }) => {
				const optDir = getOptimizationRootDir(optDirSetting);
				return getTraceWriter(optDir).appendProviderObservation(
					modelId,
					TRAJECTORY_PROVIDER_SLOT,
					row,
				);
			})
			.catch((err) => {
				this.runtime.logger?.debug?.(
					{
						src: "trajectory_logger",
						error: err instanceof Error ? err.message : String(err),
					},
					"provider_observation JSONL append failed",
				);
			});
	}

	logLlmCall(
		params: Omit<TrajectoryLlmCall, "timestamp"> & {
			modelSlot?: string;
			runId?: string;
			roomId?: string;
			messageId?: string;
			executionTraceId?: string;
		},
	): void {
		if (!isTrajectoryCaptureEnabled((k) => this.getSetting(k))) return;

		const entry: TrajectoryLlmCall = {
			stepId: params.stepId,
			model: params.model,
			systemPrompt: params.systemPrompt,
			userPrompt: params.userPrompt,
			response: params.response,
			temperature: params.temperature,
			maxTokens: params.maxTokens,
			purpose: params.purpose,
			actionType: params.actionType,
			latencyMs: params.latencyMs,
			modelSlot: params.modelSlot,
			runId: params.runId,
			roomId: params.roomId,
			messageId: params.messageId,
			executionTraceId: params.executionTraceId,
			timestamp: Date.now(),
		};
		this.llmCalls.push(entry);

		if (!isTrajectoryHistoryJsonlEnabled((k) => this.getSetting(k))) return;

		const optDirSetting = this.getSetting("OPTIMIZATION_DIR") as string | null;
		const logicalSlot = params.modelSlot ?? "TEXT_LARGE";
		const modelId = this.resolveDiskModelId(logicalSlot);
		const row: LlmObservationRecord = {
			type: "llm_observation",
			observationVersion: 1,
			createdAt: entry.timestamp,
			stepId: params.stepId,
			model: params.model,
			systemPrompt: params.systemPrompt,
			userPrompt: params.userPrompt,
			response: params.response,
			temperature: params.temperature,
			maxTokens: params.maxTokens,
			purpose: params.purpose,
			actionType: params.actionType,
			latencyMs: params.latencyMs,
			modelSlot: logicalSlot,
			runId: params.runId,
			roomId: params.roomId,
			messageId: params.messageId,
			executionTraceId: params.executionTraceId,
		};
		void import("../optimization/index.ts")
			.then(({ getOptimizationRootDir, getTraceWriter }) => {
				const optDir = getOptimizationRootDir(optDirSetting);
				return getTraceWriter(optDir).appendLlmObservation(
					modelId,
					logicalSlot,
					row,
				);
			})
			.catch((err) => {
				this.runtime.logger?.debug?.(
					{
						src: "trajectory_logger",
						error: err instanceof Error ? err.message : String(err),
					},
					"llm_observation JSONL append failed",
				);
			});
	}

	getProviderAccessLogs(): readonly TrajectoryProviderAccess[] {
		return this.providerAccess;
	}

	getLlmCallLogs(): readonly TrajectoryLlmCall[] {
		return this.llmCalls;
	}
}
