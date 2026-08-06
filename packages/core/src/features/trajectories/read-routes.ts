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
import type { IAgentRuntime, UUID } from "../../types";

interface ServiceTrajectoryListItem {
	id: string;
	agentId: string;
	source: string;
	roomId?: string | null;
	entityId?: string | null;
	metadata?: Record<string, unknown>;
	status: "active" | "completed" | "error" | "timeout";
	startTime: number;
	endTime?: number | null;
	durationMs?: number | null;
	llmCallCount: number;
	createdAt: string;
	updatedAt?: string;
}

interface ServiceLlmCall {
	callId: string;
	model: string;
	provider?: string;
	response: string;
	purpose?: string;
	actionType?: string;
	stepType?: string;
}

interface ServiceProviderAccess {
	providerId: string;
	providerName: string;
	purpose?: string;
}

interface ServiceActionAttempt {
	attemptId: string;
	actionType: string;
	actionName: string;
	success: boolean;
	error?: string;
}

interface ServiceTrajectoryStep {
	stepId: string;
	llmCalls: ServiceLlmCall[];
	providerAccesses: ServiceProviderAccess[];
	action?: ServiceActionAttempt;
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

	const steps = traj.steps;
	for (const step of steps) {
		const calls = step.llmCalls;
		for (const c of calls) {
			llmCalls.push({
				id: c.callId,
				model: c.model,
				response: c.response,
				...(c.provider ? { provider: c.provider } : {}),
				...(c.purpose ? { purpose: c.purpose } : {}),
				...(c.actionType ? { actionType: c.actionType } : {}),
				...(c.stepType ? { stepType: c.stepType } : {}),
			});
		}
		const accesses = step.providerAccesses;
		for (const p of accesses) {
			providerAccesses.push({
				id: p.providerId,
				providerName: p.providerName,
				...(p.purpose ? { purpose: p.purpose } : {}),
			});
		}
		const action = step.action;
		if (action && (action.actionName || action.actionType)) {
			const failed = action.success === false || Boolean(action.error);
			toolEvents.push({
				id: action.attemptId,
				type: failed ? "tool_error" : "tool_result",
				actionName: action.actionName || action.actionType,
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
	const isStats = pathname === "/api/trajectories/stats";
	const idMatch = pathname.match(/^\/api\/trajectories\/([^/]+)$/);
	const detailId =
		idMatch && idMatch[1] !== "stats" && idMatch[1] !== "config"
			? decodeURIComponent(idMatch[1])
			: null;
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
			const limit = Math.min(
				500,
				Math.max(1, Number(url.searchParams.get("limit")) || 50),
			);
			const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
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
