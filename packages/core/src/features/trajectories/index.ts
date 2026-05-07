import crypto from "node:crypto";
import { createUniqueUuid } from "../../entities";
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

const pendingTrajectoryStepByReplyId = new Map<string, string>();
const pendingTrajectoryStepByMessageId = new Map<string, string>();
const pendingTrajectoryMessageIdByStepId = new Map<string, string>();
const pendingTrajectoryEndTargetByStepId = new Map<string, string>();

function cleanupPendingTrajectory(
	runtime: IAgentRuntime,
	trajectoryStepId: string,
): void {
	const sourceMessageId =
		pendingTrajectoryMessageIdByStepId.get(trajectoryStepId);
	if (sourceMessageId) {
		pendingTrajectoryStepByMessageId.delete(sourceMessageId);
		pendingTrajectoryStepByReplyId.delete(
			createUniqueUuid(runtime, sourceMessageId),
		);
		pendingTrajectoryMessageIdByStepId.delete(trajectoryStepId);
	}

	pendingTrajectoryEndTargetByStepId.delete(trajectoryStepId);
}

async function endPendingTrajectory(
	runtime: IAgentRuntime,
	trajectoryStepId: string,
	status: TrajectoryFinalStatus,
): Promise<void> {
	const logger = TrajectoriesService.resolveFromRuntime(runtime);
	if (!logger) {
		cleanupPendingTrajectory(runtime, trajectoryStepId);
		return;
	}

	try {
		const endTarget =
			pendingTrajectoryEndTargetByStepId.get(trajectoryStepId) ??
			trajectoryStepId;
		await logger.endTrajectory(endTarget, status);
	} finally {
		cleanupPendingTrajectory(runtime, trajectoryStepId);
	}
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
			: typeof message.content?.channelType === "string" &&
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
	} catch {
		// Room metadata is enrichment; the trajectory itself should still be written.
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

				// Ensure metadata is initialized
				if (!message.metadata) {
					message.metadata = {
						type: "message",
					} as unknown as typeof message.metadata;
				}
				const meta = message.metadata as Record<string, unknown>;

				const logger = TrajectoriesService.resolveFromRuntime(runtime);
				if (!logger) return;

				// Start trajectory
				let trajectoryStepId: string = crypto.randomUUID();
				meta.trajectoryStepId = trajectoryStepId;

				try {
					const trajectoryMetadata = await buildTrajectoryMetadata(
						runtime,
						message,
						meta,
					);
					const trajectoryId = await logger.startTrajectory(runtime.agentId, {
						source: source ?? (meta.source as string) ?? "chat",
						metadata: trajectoryMetadata,
					});

					const normalizedTrajectoryId =
						typeof trajectoryId === "string" && trajectoryId.trim().length > 0
							? trajectoryId
							: null;

					if (normalizedTrajectoryId) {
						meta.trajectoryId = normalizedTrajectoryId;
						const runtimeStepId = logger.startStep(normalizedTrajectoryId, {
							timestamp: Date.now(),
							agentBalance: 0,
							agentPoints: 0,
							agentPnL: 0,
							openPositions: 0,
						});

						const normalizedStepId =
							typeof runtimeStepId === "string" &&
							runtimeStepId.trim().length > 0
								? runtimeStepId
								: trajectoryStepId;

						trajectoryStepId = normalizedStepId;
						meta.trajectoryStepId = trajectoryStepId;
						pendingTrajectoryEndTargetByStepId.set(
							trajectoryStepId,
							normalizedTrajectoryId,
						);
						if (typeof logger.flushWriteQueue === "function") {
							await logger.flushWriteQueue(normalizedTrajectoryId);
						}
					} else {
						// Fallback if startTrajectory returns empty/null
						// This path uses the stepId as the trajectoryId which matches legacy behavior
						// provided the logger supports it, but here we are using the new service.
						// If new service returns null, something is wrong, but we proceed best effort.
					}

					if (message.id) {
						const replyId = createUniqueUuid(runtime, message.id);
						pendingTrajectoryStepByReplyId.set(replyId, trajectoryStepId);
						pendingTrajectoryStepByMessageId.set(message.id, trajectoryStepId);
						pendingTrajectoryMessageIdByStepId.set(
							trajectoryStepId,
							message.id,
						);
					}
				} catch (err) {
					runtime.logger?.warn(
						{
							err,
							src: "trajectories",
							roomId: message.roomId,
						},
						"Failed to start trajectory logging",
					);
				}
			},
		],
		MESSAGE_SENT: [
			async (payload: MessagePayload) => {
				const { runtime, message } = payload;
				if (!message || !runtime) return;

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
					trajectoryStepId = pendingTrajectoryStepByReplyId.get(inReplyTo);
				}
				if (!trajectoryStepId) return;

				try {
					await endPendingTrajectory(runtime, trajectoryStepId, "completed");
				} catch (err) {
					runtime.logger?.warn(
						{
							err,
							src: "trajectories",
							trajectoryStepId,
						},
						"Failed to end trajectory logging",
					);
				}
			},
		],
		RUN_ENDED: [
			async (payload: RunEventPayload) => {
				const { runtime, messageId } = payload;
				if (!runtime || !messageId) return;

				const trajectoryStepId =
					pendingTrajectoryStepByMessageId.get(messageId);
				if (!trajectoryStepId) return;

				try {
					await endPendingTrajectory(
						runtime,
						trajectoryStepId,
						getFinalStatusForRun(payload),
					);
				} catch (err) {
					runtime.logger?.warn(
						{
							err,
							src: "trajectories",
							messageId,
							trajectoryStepId,
						},
						"Failed to end trajectory logging on run completion",
					);
				}
			},
		],
		RUN_TIMEOUT: [
			async (payload: RunEventPayload) => {
				const { runtime, messageId } = payload;
				if (!runtime || !messageId) return;

				const trajectoryStepId =
					pendingTrajectoryStepByMessageId.get(messageId);
				if (!trajectoryStepId) return;

				try {
					await endPendingTrajectory(runtime, trajectoryStepId, "timeout");
				} catch (err) {
					runtime.logger?.warn(
						{
							err,
							src: "trajectories",
							messageId,
							trajectoryStepId,
						},
						"Failed to end trajectory logging on run timeout",
					);
				}
			},
		],
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
// ==========================================
// GAME-KNOWLEDGE REWARDS
// ==========================================
export * from "./game-rewards";
// ==========================================
// ADVANCED: Manual Instrumentation
// ==========================================
export * from "./integration";
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
