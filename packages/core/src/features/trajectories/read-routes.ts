/**
 * Owner-side read routes for the realtime trajectory viewer
 * (`GET /api/trajectories`, `/api/trajectories/:id`, `/api/trajectories/stats`).
 *
 * These live next to the data owner (`TrajectoriesService`, this package) so the
 * viewer wire shapes stay co-located with the service that produces the data,
 * instead of being hand-mirrored in the API host.
 *
 * The realtime trajectory viewer (`@elizaos/plugin-trajectory-logger`) polls
 * these. The core `TrajectoriesService` runs on every platform, so the same
 * owner-backed wire contract is available on desktop and mobile.
 */

import type { ServerResponse } from "node:http";
import { ElizaError } from "../../errors";
import type { TrajectorySemanticStageRecord } from "../../services/trajectory-semantic-stage";
import type { IAgentRuntime, UUID } from "../../types";

interface ServiceTrajectoryListItem {
	id: string;
	agentId: string;
	source: string;
	roomId?: string | null;
	entityId?: string | null;
	metadata?: Record<string, unknown>;
	status: "active" | "completed" | "error" | "timeout" | "terminated";
	startTime: number;
	endTime?: number | null;
	durationMs?: number | null;
	stepCount?: number;
	llmCallCount: number;
	totalPromptTokens?: number;
	totalCompletionTokens?: number;
	totalCacheReadInputTokens?: number;
	totalCacheCreationInputTokens?: number;
	totalReward?: number;
	scenarioId?: string | null;
	batchId?: string | null;
	createdAt: string;
	updatedAt?: string;
}

interface ServiceLlmCall {
	callId: string;
	stepId?: string;
	trajectoryId?: string;
	timestamp?: number;
	model: string;
	modelVersion?: string;
	modelType?: string;
	provider?: string;
	systemPrompt?: string;
	userPrompt?: string;
	prompt?: string;
	messages?: unknown[];
	tools?: unknown;
	toolChoice?: unknown;
	output?: unknown;
	responseSchema?: unknown;
	providerOptions?: unknown;
	response: string;
	toolCalls?: unknown[];
	finishReason?: string;
	providerMetadata?: unknown;
	reasoning?: string;
	temperature?: number;
	maxTokens?: number;
	maxTokensOmitted?: boolean;
	topP?: number;
	purpose?: string;
	actionType?: string;
	stepType?: string;
	tags?: string[];
	latencyMs?: number;
	promptTokens?: number;
	completionTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningTokens?: number;
	modelSlot?: string;
	runId?: string;
	createdAt?: string;
}

interface ServiceProviderAccess {
	providerId: string;
	stepId?: string;
	trajectoryId?: string;
	providerName: string;
	purpose?: string;
	data?: Record<string, unknown>;
	timestamp?: number;
	startedAt?: number | null;
	endedAt?: number | null;
	durationMs?: number | null;
	overlapsWith?: Array<{ providerName: string; overlapMs: number }>;
	runId?: string;
	createdAt?: string;
}

interface ServiceActionAttempt {
	attemptId: string;
	timestamp?: number;
	actionType: string;
	actionName: string;
	parameters?: Record<string, unknown>;
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
}

interface ServiceTrajectoryStep {
	stepId: string;
	llmCalls: ServiceLlmCall[];
	providerAccesses: ServiceProviderAccess[];
	/** Absent on action-optional Agent-bridge steps (LLM-only capture). */
	action?: ServiceActionAttempt;
	semanticStages?: TrajectorySemanticStageRecord[];
}

interface ServiceTrajectory {
	trajectoryId: string;
	agentId: string;
	startTime: number;
	endTime?: number;
	steps: ServiceTrajectoryStep[];
	metrics: { finalStatus: string };
	metadata: Record<string, unknown>;
}

interface ResolvedRoomContext {
	id: string;
	name?: string;
	type?: string;
	worldId?: string;
	serverId?: string;
}

interface TrajectoriesServiceLike {
	listTrajectories?: (options: {
		limit?: number;
		offset?: number;
		source?: string;
		status?: string;
		scenarioId?: string;
		traceId?: string;
		batchId?: string;
		search?: string;
	}) => Promise<{ trajectories: ServiceTrajectoryListItem[]; total: number }>;
	getTrajectoryDetail?: (id: string) => Promise<ServiceTrajectory | null>;
	getStats?: () => Promise<unknown>;
}

function sendJson(
	res: ServerResponse,
	statusCode: number,
	body: unknown,
): void {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

/**
 * Decode the untrusted `:id` path segment. Leftover tax after media-store /
 * views-routes path work: stock develop called `decodeURIComponent` on
 * `GET /api/trajectories/:id` before the handler try/catch, so `%` / `%2` /
 * `%ZZ` threw URIError (500) instead of a typed 400. List and stats stay
 * untouched.
 */
function decodeTrajectoryId(
	raw: string,
):
	| { id: string }
	| { error: "malformed URL encoding" | "invalid path segment" } {
	try {
		const id = decodeURIComponent(raw);
		const hasControlCharacter = Array.from(id).some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || codePoint === 0x7f;
		});
		if (
			!id ||
			id === "." ||
			id === ".." ||
			id.includes("/") ||
			id.includes("\\") ||
			hasControlCharacter
		) {
			return { error: "invalid path segment" };
		}
		return { id };
	} catch {
		// error-policy:J3 malformed percent escapes are rejected at the route
		// boundary and never reach the trajectory service.
		return { error: "malformed URL encoding" };
	}
}

// timeout collapses to the viewer's tri-state "error".
function normalizeStatus(
	status: string | undefined,
): "active" | "completed" | "error" {
	if (status === "timeout" || status === "error" || status === "terminated") {
		return "error";
	}
	if (status === "active" || status === "completed") return status;
	throw new ElizaError("Trajectory list item has an invalid status", {
		code: "TRAJECTORY_READ_SHAPE_INVALID",
		context: { status },
	});
}

function metadataRoomId(
	metadata: Record<string, unknown> | undefined,
): string | null {
	return typeof metadata?.roomId === "string" ? metadata.roomId : null;
}

function metadataEntityId(
	metadata: Record<string, unknown> | undefined,
): string | null {
	return typeof metadata?.entityId === "string" ? metadata.entityId : null;
}

function listItemToUi(
	item: ServiceTrajectoryListItem,
	roomContext?: ResolvedRoomContext | null,
): Record<string, unknown> {
	const metadata = item.metadata ?? {};
	return {
		id: item.id,
		status: normalizeStatus(item.status),
		llmCallCount: item.llmCallCount,
		agentId: item.agentId,
		source: item.source,
		roomId: item.roomId ?? metadataRoomId(metadata),
		entityId: item.entityId ?? metadataEntityId(metadata),
		metadata,
		...(roomContext ? { roomContext } : {}),
		startTime: item.startTime,
		endTime: item.endTime ?? null,
		durationMs: item.durationMs ?? null,
		stepCount: item.stepCount ?? 0,
		totalPromptTokens: item.totalPromptTokens ?? 0,
		totalCompletionTokens: item.totalCompletionTokens ?? 0,
		totalCacheReadInputTokens: item.totalCacheReadInputTokens ?? 0,
		totalCacheCreationInputTokens: item.totalCacheCreationInputTokens ?? 0,
		totalReward: item.totalReward ?? 0,
		scenarioId: item.scenarioId ?? null,
		batchId: item.batchId ?? null,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt ?? item.createdAt,
	};
}

// Flatten the recorded steps into the flat UI arrays the viewer's phase
// classifier (`summarizePhases`) reads: llmCalls keyed by stepType/purpose drive
// HANDLE/PLAN/EVALUATE; the per-step action drives the ACTION phase.
function detailToUi(
	traj: ServiceTrajectory,
	roomContext?: ResolvedRoomContext | null,
): Record<string, unknown> {
	const id = String(traj.trajectoryId);
	const metadata = traj.metadata;
	const llmCalls: Array<Record<string, unknown>> = [];
	const providerAccesses: Array<Record<string, unknown>> = [];
	const toolEvents: Array<Record<string, unknown>> = [];
	const semanticStages: TrajectorySemanticStageRecord[] = [];

	const steps = traj.steps;
	for (const step of steps) {
		if (step.semanticStages) semanticStages.push(...step.semanticStages);
		const calls = step.llmCalls;
		for (const c of calls) {
			llmCalls.push({
				id: c.callId,
				stepId: c.stepId ?? step.stepId,
				trajectoryId: c.trajectoryId ?? id,
				...(c.timestamp !== undefined ? { timestamp: c.timestamp } : {}),
				model: c.model,
				...(c.modelVersion ? { modelVersion: c.modelVersion } : {}),
				...(c.modelType ? { modelType: c.modelType } : {}),
				...(c.provider ? { provider: c.provider } : {}),
				...(c.systemPrompt !== undefined
					? { systemPrompt: c.systemPrompt }
					: {}),
				...(c.userPrompt !== undefined ? { userPrompt: c.userPrompt } : {}),
				...(c.prompt !== undefined ? { prompt: c.prompt } : {}),
				...(c.messages !== undefined ? { messages: c.messages } : {}),
				...(c.tools !== undefined ? { tools: c.tools } : {}),
				...(c.toolChoice !== undefined ? { toolChoice: c.toolChoice } : {}),
				...(c.output !== undefined ? { output: c.output } : {}),
				...(c.responseSchema !== undefined
					? { responseSchema: c.responseSchema }
					: {}),
				...(c.providerOptions !== undefined
					? { providerOptions: c.providerOptions }
					: {}),
				response: c.response,
				...(c.toolCalls !== undefined ? { toolCalls: c.toolCalls } : {}),
				...(c.finishReason ? { finishReason: c.finishReason } : {}),
				...(c.providerMetadata !== undefined
					? { providerMetadata: c.providerMetadata }
					: {}),
				...(c.reasoning ? { reasoning: c.reasoning } : {}),
				...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
				...(c.maxTokens !== undefined ? { maxTokens: c.maxTokens } : {}),
				...(c.maxTokensOmitted !== undefined
					? { maxTokensOmitted: c.maxTokensOmitted }
					: {}),
				...(c.topP !== undefined ? { topP: c.topP } : {}),
				...(c.purpose ? { purpose: c.purpose } : {}),
				...(c.actionType ? { actionType: c.actionType } : {}),
				...(c.stepType ? { stepType: c.stepType } : {}),
				...(c.tags ? { tags: c.tags } : {}),
				...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
				...(c.promptTokens !== undefined
					? { promptTokens: c.promptTokens }
					: {}),
				...(c.completionTokens !== undefined
					? { completionTokens: c.completionTokens }
					: {}),
				...(c.cacheReadInputTokens !== undefined
					? { cacheReadInputTokens: c.cacheReadInputTokens }
					: {}),
				...(c.cacheCreationInputTokens !== undefined
					? { cacheCreationInputTokens: c.cacheCreationInputTokens }
					: {}),
				...(c.reasoningTokens !== undefined
					? { reasoningTokens: c.reasoningTokens }
					: {}),
				...(c.modelSlot ? { modelSlot: c.modelSlot } : {}),
				...(c.runId ? { runId: c.runId } : {}),
				...(c.createdAt ? { createdAt: c.createdAt } : {}),
			});
		}
		const accesses = step.providerAccesses;
		for (const p of accesses) {
			providerAccesses.push({
				id: p.providerId,
				stepId: p.stepId ?? step.stepId,
				trajectoryId: p.trajectoryId ?? id,
				providerName: p.providerName,
				...(p.purpose ? { purpose: p.purpose } : {}),
				...(p.data !== undefined ? { data: p.data } : {}),
				...(p.timestamp !== undefined ? { timestamp: p.timestamp } : {}),
				...(p.startedAt !== undefined ? { startedAt: p.startedAt } : {}),
				...(p.endedAt !== undefined ? { endedAt: p.endedAt } : {}),
				...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
				...(p.overlapsWith ? { overlapsWith: p.overlapsWith } : {}),
				...(p.runId ? { runId: p.runId } : {}),
				...(p.createdAt ? { createdAt: p.createdAt } : {}),
			});
		}
		// Genuinely actionless steps (Agent bridge LLM-only capture) contribute
		// nothing to toolEvents — never fabricate a synthetic action (#17730).
		const action = step.action;
		if (action && (action.actionName || action.actionType)) {
			const failed = action.success === false || Boolean(action.error);
			toolEvents.push({
				id: action.attemptId,
				type: failed ? "tool_error" : "tool_result",
				actionName: action.actionName || action.actionType,
				...(action.timestamp !== undefined
					? { timestamp: action.timestamp }
					: {}),
				...(action.parameters ? { args: action.parameters } : {}),
				...(action.result ? { result: action.result } : {}),
				status: failed ? "failed" : "completed",
				success: !failed,
				...(action.error ? { error: action.error } : {}),
			});
		}
	}

	const finalStatus = traj.metrics.finalStatus;
	const status: "active" | "completed" | "error" =
		finalStatus === "timeout" ||
		finalStatus === "terminated" ||
		finalStatus === "error"
			? "error"
			: finalStatus === "completed"
				? "completed"
				: "active";

	const startTime = traj.startTime;
	const endTime =
		typeof traj.endTime === "number" && traj.endTime > 0 ? traj.endTime : null;
	const durationMs =
		endTime !== null && startTime > 0 ? Math.max(0, endTime - startTime) : null;
	return {
		trajectory: {
			id,
			agentId: traj.agentId,
			...(typeof metadata.source === "string"
				? { source: metadata.source }
				: {}),
			roomId: metadataRoomId(metadata),
			entityId: metadataEntityId(metadata),
			metadata,
			...(roomContext ? { roomContext } : {}),
			status,
			startTime,
			endTime,
			durationMs,
			llmCallCount: llmCalls.length,
			providerAccessCount: providerAccesses.length,
			createdAt: new Date(startTime).toISOString(),
		},
		llmCalls,
		providerAccesses,
		toolEvents,
		evaluationEvents: [],
		semanticStages,
	};
}

async function resolveRoomContext(
	runtime: IAgentRuntime | null | undefined,
	roomId: string | null | undefined,
	cache: Map<string, ResolvedRoomContext | null>,
): Promise<ResolvedRoomContext | null> {
	if (!roomId) return null;
	if (cache.has(roomId)) return cache.get(roomId) ?? null;
	const room = await runtime?.getRoom?.(roomId as UUID);
	const context = room
		? {
				id: String(room.id || roomId),
				...(typeof room.name === "string" ? { name: room.name } : {}),
				...(typeof room.type === "string" ? { type: room.type } : {}),
				...(typeof room.worldId === "string" ? { worldId: room.worldId } : {}),
				...(typeof room.serverId === "string"
					? { serverId: room.serverId }
					: {}),
			}
		: null;
	cache.set(roomId, context);
	return context;
}

/**
 * Handle the trajectory viewer READ routes from the core `TrajectoriesService`.
 * Returns `true` when the request was handled (even on error), `false` when the
 * path/method does not belong to these read routes.
 */
export async function tryHandleTrajectoryReadRoutes(options: {
	pathname: string;
	method: string;
	url: URL;
	runtime: IAgentRuntime | null | undefined;
	res: ServerResponse;
}): Promise<boolean> {
	const { pathname, method, url, runtime, res } = options;
	if (method !== "GET" || !pathname.startsWith("/api/trajectories")) {
		return false;
	}
	// Only the read routes the viewer needs belong to this boundary. Unsupported
	// mutation and export paths fall through for the API host to reject.
	const isList = pathname === "/api/trajectories";
	let isStats = pathname === "/api/trajectories/stats";
	const idMatch = pathname.match(/^\/api\/trajectories\/([^/]+)$/);
	let detailId: string | null = null;
	if (idMatch) {
		const decoded = decodeTrajectoryId(idMatch[1] ?? "");
		if ("error" in decoded) {
			sendJson(res, 400, {
				error: `invalid trajectory id: ${decoded.error}`,
			});
			return true;
		}
		// Classify reserved segments after decoding so percent encoding cannot
		// turn a host-owned route into a trajectory lookup.
		if (decoded.id === "stats") isStats = true;
		else if (decoded.id !== "config") detailId = decoded.id;
	}
	if (!isList && !isStats && !detailId) {
		return false;
	}

	const service = runtime?.getService?.("trajectories") as
		| TrajectoriesServiceLike
		| null
		| undefined;
	if (!service) {
		sendJson(res, 503, { error: "Trajectory service unavailable" });
		return true;
	}

	const shouldResolveRooms = url.searchParams.get("resolve") === "1";
	const roomCache = new Map<string, ResolvedRoomContext | null>();

	try {
		if (isStats) {
			if (!service.getStats) {
				throw new ElizaError("Trajectory service does not support statistics", {
					code: "TRAJECTORY_READ_UNSUPPORTED",
				});
			}
			const stats = await service.getStats();
			sendJson(res, 200, stats);
			return true;
		}
		if (isList) {
			if (!service.listTrajectories) {
				throw new ElizaError(
					"Trajectory service does not support list queries",
					{
						code: "TRAJECTORY_READ_UNSUPPORTED",
					},
				);
			}
			const rawLimit = url.searchParams.get("limit");
			const requestedLimit = rawLimit === null ? Number.NaN : Number(rawLimit);
			const limit = Number.isFinite(requestedLimit)
				? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
				: 50;
			const rawOffset = url.searchParams.get("offset");
			const requestedOffset =
				rawOffset === null ? Number.NaN : Number(rawOffset);
			const offset = Number.isFinite(requestedOffset)
				? Math.max(0, Math.trunc(requestedOffset))
				: 0;
			const result = await service.listTrajectories({
				limit,
				offset,
				source: url.searchParams.get("source") || undefined,
				status: url.searchParams.get("status") || undefined,
				scenarioId: url.searchParams.get("scenarioId") || undefined,
				// Correlation join key (#13775): list every trajectory in one trace.
				traceId: url.searchParams.get("traceId") || undefined,
				batchId: url.searchParams.get("batchId") || undefined,
				// The SQL reader filters + counts by `search` (id/scenario_id/
				// batch_id/metadata/steps_json LIKE). On mobile this owns
				// /api/trajectories, so without forwarding `search` the viewer's
				// search box returned the full unfiltered list.
				search: url.searchParams.get("search") || undefined,
			});
			const trajectories = shouldResolveRooms
				? await Promise.all(
						result.trajectories.map(async (item) =>
							listItemToUi(
								item,
								await resolveRoomContext(
									runtime,
									item.roomId ?? metadataRoomId(item.metadata),
									roomCache,
								),
							),
						),
					)
				: result.trajectories.map((item) => listItemToUi(item));
			sendJson(res, 200, {
				trajectories,
				total: result.total,
				offset,
				limit,
			});
			return true;
		}
		// detail
		if (!service.getTrajectoryDetail) {
			throw new ElizaError(
				"Trajectory service does not support detail queries",
				{
					code: "TRAJECTORY_READ_UNSUPPORTED",
				},
			);
		}
		const traj = detailId ? await service.getTrajectoryDetail(detailId) : null;
		if (!traj) {
			sendJson(res, 404, { error: `Trajectory "${detailId}" not found` });
			return true;
		}
		sendJson(
			res,
			200,
			detailToUi(
				traj,
				shouldResolveRooms
					? await resolveRoomContext(
							runtime,
							metadataRoomId(traj.metadata),
							roomCache,
						)
					: null,
			),
		);
		return true;
	} catch (err) {
		// error-policy:J1 HTTP status and JSON form the trajectory read boundary's
		// structured failure response.
		sendJson(res, 500, {
			error: err instanceof Error ? err.message : "Trajectory read failed",
		});
		return true;
	}
}
