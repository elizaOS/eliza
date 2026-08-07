/**
 * Public barrel and plugin entry for the trajectories capability: exports the
 * native `trajectoriesPlugin`, the `TrajectoriesService`, and the feature's
 * type/format/pricing/export surface (ART conversion, reward services, action
 * interceptor, per-provider price table).
 *
 * The plugin owns the trajectory lifecycle by listening to runtime events: it
 * opens a trajectory + first step on `MESSAGE_RECEIVED` (enriching metadata from
 * room state / web-conversation context) and closes it on `RUN_ENDED` or
 * `RUN_TIMEOUT`. `MESSAGE_SENT` remains the fallback for delivery-only producers
 * that have no enclosing run owner. Because event ordering is not guaranteed,
 * the per-runtime maps correlate a message/reply id to its open step so whichever
 * applicable terminal event fires first can atomically claim and end it once;
 * `cleanupPendingTrajectory` tears down every index entry to avoid leaks.
 * Trajectory capture is best-effort — every failure is logged and swallowed so
 * it never blocks the message loop, and the whole subsystem no-ops when
 * `TrajectoriesService` is not resolvable (e.g. `@elizaos/plugin-sql` absent).
 */
import crypto from "node:crypto";
import { createUniqueUuid } from "../../entities";
import { ElizaError } from "../../errors";
import { resolveTraceCorrelationFromEnv } from "../../runtime/trace-correlation";
import type { TrajectoryFinalStatus } from "../../trajectory-utils";
import type {
	IAgentRuntime,
	JsonValue,
	MessagePayload,
	Plugin,
	RunEventPayload,
} from "../../types";
import { asRecordOrUndefined } from "../../utils/type-guards.ts";
import { TrajectoriesService } from "./TrajectoriesService";

type PendingTrajectoryState = {
	stepByReplyId: Map<string, string>;
	stepByMessageId: Map<string, string>;
	messageIdByStepId: Map<string, string>;
	endTargetByStepId: Map<string, string>;
};

const pendingTrajectoriesByRuntime = new WeakMap<
	object,
	PendingTrajectoryState
>();

function getPendingTrajectoryState(
	runtime: IAgentRuntime,
): PendingTrajectoryState {
	const key = runtime as object;
	let state = pendingTrajectoriesByRuntime.get(key);
	if (!state) {
		state = {
			stepByReplyId: new Map(),
			stepByMessageId: new Map(),
			messageIdByStepId: new Map(),
			endTargetByStepId: new Map(),
		};
		pendingTrajectoriesByRuntime.set(key, state);
	}
	return state;
}

function cleanupPendingTrajectory(
	runtime: IAgentRuntime,
	trajectoryStepId: string,
): void {
	const state = pendingTrajectoriesByRuntime.get(runtime as object);
	if (!state) return;
	const sourceMessageId = state.messageIdByStepId.get(trajectoryStepId);
	if (sourceMessageId) {
		state.stepByMessageId.delete(sourceMessageId);
		state.stepByReplyId.delete(createUniqueUuid(runtime, sourceMessageId));
		state.messageIdByStepId.delete(trajectoryStepId);
	}

	state.endTargetByStepId.delete(trajectoryStepId);
	if (
		state.stepByReplyId.size === 0 &&
		state.stepByMessageId.size === 0 &&
		state.messageIdByStepId.size === 0 &&
		state.endTargetByStepId.size === 0
	) {
		pendingTrajectoriesByRuntime.delete(runtime as object);
	}
}

function claimPendingTrajectory(
	runtime: IAgentRuntime,
	trajectoryStepId: string,
): string | null {
	const state = pendingTrajectoriesByRuntime.get(runtime as object);
	if (!state) return null;
	const endTarget = state.endTargetByStepId.get(trajectoryStepId);
	if (!endTarget) return null;
	cleanupPendingTrajectory(runtime, trajectoryStepId);
	return endTarget;
}

async function endPendingTrajectory(
	runtime: IAgentRuntime,
	trajectoryStepId: string,
	status: TrajectoryFinalStatus,
): Promise<void> {
	const endTarget = claimPendingTrajectory(runtime, trajectoryStepId);
	if (!endTarget) return;
	const logger = TrajectoriesService.resolveFromRuntime(runtime);
	if (!logger) return;

	let firstFailure: unknown;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			await logger.endTrajectory(endTarget, status);
			return;
		} catch (error) {
			if (attempt === 1) {
				firstFailure = error;
				// error-policy:J7 terminal ownership stays claimed while one bounded
				// durability retry repairs transient storage failures.
				runtime.reportError("TrajectoriesPlugin.endRetry", error, {
					trajectoryStepId,
					endTarget,
					status,
					attempt,
					diagnosticOnly: true,
				});
				continue;
			}
			logger.releaseTrajectoryOwnership(endTarget);
			throw new ElizaError("Trajectory terminalization retry failed", {
				code: "TRAJECTORY_TERMINALIZATION_FAILED",
				cause: new AggregateError([firstFailure, error]),
				context: { trajectoryStepId, endTarget, status, attempts: 2 },
			});
		}
	}
}

async function terminalizeFailedTrajectoryStart(
	runtime: IAgentRuntime,
	logger: TrajectoriesService,
	trajectoryId: string,
): Promise<void> {
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			await logger.endTrajectory(trajectoryId, "error");
			return;
		} catch (error) {
			// error-policy:J7 A partially-started diagnostic row must not remain
			// active; one bounded retry handles a transient child/index failure.
			runtime.reportError("TrajectoriesPlugin.startCleanup", error, {
				trajectoryId,
				attempt,
				diagnosticOnly: true,
			});
		}
	}
	logger.releaseTrajectoryOwnership(trajectoryId);
}

function getFinalStatusForRun(payload: RunEventPayload): TrajectoryFinalStatus {
	if (payload.status === "timeout") {
		return "timeout";
	}

	return payload.status === "completed" ? "completed" : "terminated";
}

const WEB_CONVERSATION_STRING_KEYS = [
	"conversationId",
	"scope",
	"automationType",
	"taskId",
	"triggerId",
	"workflowId",
	"workflowName",
	"draftId",
	"pageId",
	"sourceConversationId",
	"terminalBridgeConversationId",
] as const;

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function copyJsonMetadataField(
	target: Record<string, JsonValue>,
	source: Record<string, unknown>,
	key: string,
): void {
	const value = source[key];
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		target[key] = value;
	}
}

function readStoredWebConversation(
	roomMetadata: unknown,
): Record<string, JsonValue> | undefined {
	const stored = asRecordOrUndefined(
		asRecordOrUndefined(roomMetadata)?.webConversation,
	);
	if (!stored) return undefined;

	const webConversation: Record<string, JsonValue> = {};
	for (const key of WEB_CONVERSATION_STRING_KEYS) {
		const value = readNonEmptyString(stored[key]);
		if (value) webConversation[key] = value;
	}

	return Object.keys(webConversation).length > 0 ? webConversation : undefined;
}

async function buildTrajectoryMetadata(
	runtime: IAgentRuntime,
	message: MessagePayload["message"],
	meta: Record<string, unknown>,
): Promise<Record<string, JsonValue>> {
	const metadata: Record<string, JsonValue> = {
		roomId: message.roomId,
		entityId: message.entityId,
	};

	if (typeof message.id === "string" && message.id.length > 0) {
		metadata.messageId = message.id;
	}

	const channelType =
		typeof meta.channelType === "string" && meta.channelType.length > 0
			? meta.channelType
			: typeof message.content.channelType === "string" &&
					message.content.channelType.length > 0
				? message.content.channelType
				: null;
	if (channelType) {
		metadata.channelType = channelType;
	}

	if (typeof meta.sessionKey === "string" && meta.sessionKey.length > 0) {
		metadata.conversationId = meta.sessionKey;
	}

	for (const key of [
		"taskId",
		"surface",
		"surfaceVersion",
		"pageId",
		"sourceConversationId",
		"scenarioId",
		"batchId",
		// Correlation join key (#13775) stamped on message.metadata at the turn
		// boundary before MESSAGE_RECEIVED so the DB trajectory shares the file
		// recorder's traceId.
		"traceId",
	]) {
		copyJsonMetadataField(metadata, meta, key);
	}

	try {
		const room = await runtime.getRoom(message.roomId);
		const webConversation = readStoredWebConversation(room?.metadata);
		if (webConversation) {
			metadata.webConversation = webConversation;

			const scope = readNonEmptyString(webConversation.scope);
			if (scope?.startsWith("page-")) {
				if (!metadata.taskId) metadata.taskId = scope;
				if (!metadata.surface) metadata.surface = "page-scoped";
				if (!metadata.pageId && webConversation.pageId) {
					metadata.pageId = webConversation.pageId;
				}
				if (
					!metadata.sourceConversationId &&
					webConversation.sourceConversationId
				) {
					metadata.sourceConversationId = webConversation.sourceConversationId;
				}
			}
		}
	} catch (error) {
		// error-policy:J7 Room metadata is optional trajectory enrichment; the
		// lookup failure is reported without dropping the trajectory.
		runtime.reportError("TrajectoriesPlugin.roomMetadata", error, {
			roomId: message.roomId,
			diagnosticOnly: true,
		});
	}

	return metadata;
}

/**
 * Native trajectories plugin.
 *
 * Captures complete agent interaction trajectories for:
 * - Debugging and analysis (UI viewing)
 * - RL training data collection
 * - Export to various formats (JSON, ART, CSV)
 *
 * Registers the native "trajectories" service so the runtime can automatically
 * log LLM calls and provider accesses when trajectory capture is active.
 */
export const trajectoriesPlugin: Plugin = {
	name: "trajectories",
	description:
		"Captures and persists complete agent interaction trajectories for debugging, analysis, and RL training. " +
		"Records LLM calls, provider accesses, actions, environment state, and computes rewards.",
	dependencies: ["@elizaos/plugin-sql"],
	services: [TrajectoriesService],
	events: {
		MESSAGE_RECEIVED: [
			async (payload: MessagePayload) => {
				const { runtime, message, source } = payload;
				if (!message || !runtime) return;
				if (typeof message.id !== "string" || message.id.length === 0) {
					runtime.reportError(
						"TrajectoriesPlugin.start",
						new ElizaError("Trajectory capture requires a message id", {
							code: "TRAJECTORY_MESSAGE_ID_REQUIRED",
							context: { roomId: message.roomId },
						}),
						{ roomId: message.roomId, diagnosticOnly: true },
					);
					return;
				}

				// Ensure metadata is initialized
				if (!message.metadata) {
					message.metadata = {
						type: "message",
					};
				}
				const meta = message.metadata as Record<string, unknown>;

				// Trace correlation (#13775): on emit-first paths (the agent API chat
				// route and connectors that emit MESSAGE_RECEIVED before calling
				// messageService.handleMessage) this handler runs BEFORE message.ts
				// mints the turn's traceId, so the DB row would persist a NULL
				// trace_id and never join the file trajectory. Mint at the first
				// touchpoint instead: inherit a spawning parent's ELIZA_TRACE_ID, else
				// a fresh id, and stamp message.metadata so message.ts reuses it.
				if (
					typeof meta.traceId !== "string" ||
					meta.traceId.trim().length === 0
				) {
					meta.traceId =
						resolveTraceCorrelationFromEnv().traceId ?? crypto.randomUUID();
				}

				const logger = TrajectoriesService.resolveFromRuntime(runtime);
				if (!logger) return;

				// Start trajectory
				let trajectoryStepId: string = crypto.randomUUID();
				let startedTrajectoryId: string | undefined;
				meta.trajectoryStepId = trajectoryStepId;

				try {
					const trajectoryMetadata = await buildTrajectoryMetadata(
						runtime,
						message,
						meta,
					);
					const scenarioId = readNonEmptyString(trajectoryMetadata.scenarioId);
					const batchId = readNonEmptyString(trajectoryMetadata.batchId);
					const traceId = readNonEmptyString(trajectoryMetadata.traceId);
					const trajectoryId = await logger.startTrajectory(runtime.agentId, {
						source: source ?? (meta.source as string) ?? "chat",
						metadata: trajectoryMetadata,
						...(scenarioId ? { scenarioId } : {}),
						...(batchId ? { batchId } : {}),
						...(traceId ? { traceId } : {}),
					});

					const normalizedTrajectoryId =
						typeof trajectoryId === "string" && trajectoryId.trim().length > 0
							? trajectoryId
							: null;

					if (normalizedTrajectoryId) {
						startedTrajectoryId = normalizedTrajectoryId;
						meta.trajectoryId = normalizedTrajectoryId;
						const runtimeStepId = logger.startStep(normalizedTrajectoryId, {
							timestamp: Date.now(),
						});

						const normalizedStepId =
							typeof runtimeStepId === "string" &&
							runtimeStepId.trim().length > 0
								? runtimeStepId
								: trajectoryStepId;

						trajectoryStepId = normalizedStepId;
						meta.trajectoryStepId = trajectoryStepId;
						getPendingTrajectoryState(runtime).endTargetByStepId.set(
							trajectoryStepId,
							normalizedTrajectoryId,
						);
						if (typeof logger.flushWriteQueue === "function") {
							await logger.flushWriteQueue(normalizedTrajectoryId);
						}
					} else {
						// startTrajectory returned empty/null: no trajectory id to record
						// steps against, so proceed best-effort with the local stepId as the
						// only correlation handle for the terminal events below.
					}

					const state = getPendingTrajectoryState(runtime);
					const replyId = createUniqueUuid(runtime, message.id);
					state.stepByReplyId.set(replyId, trajectoryStepId);
					state.stepByMessageId.set(message.id, trajectoryStepId);
					state.messageIdByStepId.set(trajectoryStepId, message.id);
				} catch (err) {
					// error-policy:J7 Trajectory logging is diagnostic and cannot
					// abort the message event it observes.
					if (startedTrajectoryId) {
						await terminalizeFailedTrajectoryStart(
							runtime,
							logger,
							startedTrajectoryId,
						);
					}
					cleanupPendingTrajectory(runtime, trajectoryStepId);
					delete meta.trajectoryId;
					delete meta.trajectoryStepId;
					runtime.logger.warn(
						{
							err,
							src: "trajectories",
							roomId: message.roomId,
						},
						"Failed to start trajectory logging",
					);
					runtime.reportError("TrajectoriesPlugin.start", err, {
						roomId: message.roomId,
						diagnosticOnly: true,
					});
				}
			},
		],
		MESSAGE_SENT: [
			async (payload: MessagePayload) => {
				const { runtime, message, trajectoryTerminalOwner } = payload;
				if (!message || !runtime) return;
				// A live message-service run owns terminalization through RUN_ENDED so
				// its post-turn evaluator child can finish first. Delivery-only emitters
				// omit this capability and retain MESSAGE_SENT as their terminal fallback.
				if (trajectoryTerminalOwner === "run") return;

				const meta = message.metadata as Record<string, unknown> | undefined;
				const inReplyTo =
					typeof message.content === "object" &&
					message.content !== null &&
					"inReplyTo" in message.content &&
					typeof (message.content as { inReplyTo?: unknown }).inReplyTo ===
						"string"
						? (message.content as { inReplyTo: string }).inReplyTo
						: undefined;

				let trajectoryStepId = meta?.trajectoryStepId as string | undefined;
				if (!trajectoryStepId && inReplyTo) {
					trajectoryStepId = pendingTrajectoriesByRuntime
						.get(runtime as object)
						?.stepByReplyId.get(inReplyTo);
				}
				if (!trajectoryStepId) return;

				try {
					await endPendingTrajectory(runtime, trajectoryStepId, "completed");
				} catch (err) {
					// error-policy:J7 Trajectory logging is diagnostic and cannot
					// abort the sent-message event it observes.
					runtime.logger.warn(
						{
							err,
							src: "trajectories",
							trajectoryStepId,
						},
						"Failed to end trajectory logging",
					);
					runtime.reportError("TrajectoriesPlugin.endMessage", err, {
						trajectoryStepId,
						diagnosticOnly: true,
					});
				}
			},
		],
		RUN_ENDED: [
			async (payload: RunEventPayload) => {
				const { runtime, messageId } = payload;
				if (!runtime || !messageId) return;

				const trajectoryStepId = pendingTrajectoriesByRuntime
					.get(runtime as object)
					?.stepByMessageId.get(messageId);
				if (!trajectoryStepId) return;

				try {
					await endPendingTrajectory(
						runtime,
						trajectoryStepId,
						getFinalStatusForRun(payload),
					);
				} catch (err) {
					// error-policy:J7 Trajectory logging is diagnostic and cannot
					// abort the run-completion event it observes.
					runtime.logger.warn(
						{
							err,
							src: "trajectories",
							messageId,
							trajectoryStepId,
						},
						"Failed to end trajectory logging on run completion",
					);
					runtime.reportError("TrajectoriesPlugin.endRun", err, {
						messageId,
						trajectoryStepId,
						diagnosticOnly: true,
					});
				}
			},
		],
		RUN_TIMEOUT: [
			async (payload: RunEventPayload) => {
				const { runtime, messageId } = payload;
				if (!runtime || !messageId) return;

				const trajectoryStepId = pendingTrajectoriesByRuntime
					.get(runtime as object)
					?.stepByMessageId.get(messageId);
				if (!trajectoryStepId) return;

				try {
					await endPendingTrajectory(runtime, trajectoryStepId, "timeout");
				} catch (err) {
					// error-policy:J7 Trajectory logging is diagnostic and cannot
					// abort the run-timeout event it observes.
					runtime.logger.warn(
						{
							err,
							src: "trajectories",
							messageId,
							trajectoryStepId,
						},
						"Failed to end trajectory logging on run timeout",
					);
					runtime.reportError("TrajectoriesPlugin.timeout", err, {
						messageId,
						trajectoryStepId,
						diagnosticOnly: true,
					});
				}
			},
		],
	},
	async dispose(runtime: IAgentRuntime) {
		const pending = pendingTrajectoriesByRuntime.get(runtime as object);
		const stepIds = pending ? [...pending.endTargetByStepId.keys()] : [];
		for (const stepId of stepIds) {
			try {
				await endPendingTrajectory(runtime, stepId, "terminated");
			} catch (error) {
				// error-policy:J7 disposal drains every remaining owner and reports a
				// failed terminal diagnostic without preventing service shutdown.
				runtime.reportError("TrajectoriesPlugin.dispose", error, {
					trajectoryStepId: stepId,
					diagnosticOnly: true,
				});
			}
		}
		pendingTrajectoriesByRuntime.delete(runtime as object);
		const svc = runtime.getService<TrajectoriesService>(
			TrajectoriesService.serviceType,
		);
		await svc?.stop();
	},
};

export default trajectoriesPlugin;

export type { TrajectoryExportOptions } from "../../services/trajectory-types.ts";
// ==========================================
// ACTION-LEVEL INSTRUMENTATION
// For manual trajectory collection in actions
// ==========================================
export * from "./action-interceptor";
// ==========================================
// TRAJECTORY FORMAT CONVERSION
// ==========================================
export * from "./art-format";
// ==========================================
// DATA EXPORT
// ==========================================
export * from "./export";
// ADVANCED: Manual Instrumentation
// ==========================================
export * from "./integration";
export type {
	ModelPriceUsdPerMTokens,
	PriceLookupResult,
	PriceTableId,
	ProviderName,
	TokenUsageForCost,
} from "./pricing";
// ==========================================
// PRICING — per-provider LLM cost table (M40 / W1-X1)
// ==========================================
export {
	computeCallCostUsd,
	isLocalProvider,
	lookupModelPrice,
	MODEL_PRICES_USD_PER_M_TOKENS,
	PRICE_TABLE_ID,
} from "./pricing";
// ==========================================
// OPTIONAL: Heuristic Rewards
// ==========================================
export * from "./reward-service";
export type {
	TrajectoryListItem,
	TrajectoryListOptions,
	TrajectoryListResult,
	TrajectoryStats,
	TrajectoryZipEntry,
	TrajectoryZipExportOptions,
	TrajectoryZipExportResult,
} from "./TrajectoriesService";
// ==========================================
// SERVICE (Core trajectory logging)
// ==========================================
export { TrajectoriesService } from "./TrajectoriesService";
// ==========================================
// CORE TYPES
// ==========================================
export * from "./types";
