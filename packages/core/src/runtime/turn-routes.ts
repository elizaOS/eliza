/**
 * HTTP routes for turn control.
 *
 * Exposes the turn-scoped AbortController registry over a small HTTP surface
 * so UI stop buttons, connector cancel-on-typing, and external orchestrators
 * can abort the agent's in-flight work for a given room.
 *
 * Routes:
 *   POST /api/turns/:roomId/abort
 *     body: { reason?: string, clientMessageId?: string }
 *     With `clientMessageId`, cancellation targets one exact request. If that
 *     request has not registered yet, a bounded tombstone closes the race and
 *     the route settles immediately without blocking a newer request id.
 *     Exact 200 { requestObserved, requestArmed, requestArmRejected,
 *                 requestAborted, requestIngressState,
 *                 requestIngressFailure, requestSettled,
 *                 ...legacyRoomStatus }
 *     Room-only 200 { aborted, observed, settled }
 *       `settled:true` proves the exact turn + room owner observed by this
 *       request released. `aborted:false, settled:false` is the expected
 *       pre-registration status while an SSE route owns the room but has not
 *       installed its TurnController yet; callers may retry under a deadline.
 *
 *   GET /api/turns/:roomId
 *     200 { active: boolean, hasSignal: boolean }
 *
 * Registered by the basic-capabilities plugin so every runtime gets them.
 */

import type { Route } from "../types/plugin";

const TURN_ABORT_SETTLEMENT_TIMEOUT_MS = 750;
const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;

function normalizeClientMessageId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 &&
		normalized.length <= MAX_CLIENT_MESSAGE_ID_LENGTH
		? normalized
		: null;
}

async function waitForSettlementBounded(
	settlements: readonly Promise<void>[],
): Promise<boolean> {
	if (settlements.length === 0) return true;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.all(settlements).then(() => true),
			new Promise<false>((resolve) => {
				timeout = setTimeout(
					() => resolve(false),
					TURN_ABORT_SETTLEMENT_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

const TURN_ABORT_ROUTE: Route = {
	type: "POST",
	path: "/api/turns/:roomId/abort",
	rawPath: true,
	name: "turn-abort",
	description: "Abort the active message-handler turn for a given room.",
	async handler(req, res, runtime) {
		const params = (req.params ?? {}) as Record<string, unknown>;
		const roomId = typeof params.roomId === "string" ? params.roomId : "";
		if (!roomId) {
			res.status(400).json({ error: "roomId required" });
			return;
		}
		const body = (req.body ?? {}) as Record<string, unknown>;
		const reason =
			typeof body.reason === "string" && body.reason.length > 0
				? body.reason
				: "external_request";
		const clientMessageId = normalizeClientMessageId(body.clientMessageId);
		if (body.clientMessageId !== undefined && clientMessageId === null) {
			res.status(400).json({
				error:
					"clientMessageId must be a non-empty string of at most 128 characters",
			});
			return;
		}
		if (clientMessageId) {
			const exact = runtime.turnControllers.abortRequestAdmission(
				roomId,
				clientMessageId,
				reason,
			);
			const requestSettled = exact.requestArmRejected
				? false
				: await waitForSettlementBounded([exact.settlement]);
			res.status(200).json({
				requestAborted: exact.requestAborted,
				requestObserved: exact.requestObserved,
				requestArmed: exact.requestArmed,
				requestArmRejected: exact.requestArmRejected,
				requestIngressState: exact.requestIngressState,
				requestIngressFailure: exact.requestIngressFailure,
				requestSettled,
				// Exact cancellation never claims or mutates room-level authority.
				// Preserve the legacy response keys as explicit neutral values so an
				// old caller fails closed instead of confusing request settlement for
				// proof that the room's current turn was aborted.
				aborted: false,
				observed: false,
				settled: false,
				active: runtime.turnControllers.hasActiveTurn(roomId),
				queuePending: runtime.roomHandlerQueue.pendingFor(roomId),
				roomId,
				clientMessageId,
				reason,
			});
			return;
		}
		// Snapshot both capabilities before firing abort. A fast abort may settle
		// synchronously enough that looking them up afterward loses the proof.
		const turnSettlement = runtime.turnControllers.settlementFor(roomId);
		const ownerSettlement =
			runtime.roomHandlerQueue.currentOwnerSettlement(roomId);
		const observed = turnSettlement !== null;
		const aborted = runtime.turnControllers.abortTurn(roomId, reason);
		const shouldAwaitSettlement = aborted || observed;
		const settled = shouldAwaitSettlement
			? await waitForSettlementBounded(
					[turnSettlement, ownerSettlement].filter(
						(value): value is Promise<void> => value !== null,
					),
				)
			: ownerSettlement === null;
		res.status(200).json({
			aborted,
			observed,
			settled,
			active: runtime.turnControllers.hasActiveTurn(roomId),
			queuePending: runtime.roomHandlerQueue.pendingFor(roomId),
			roomId,
			reason,
		});
	},
};

const TURN_STATUS_ROUTE: Route = {
	type: "GET",
	path: "/api/turns/:roomId",
	rawPath: true,
	name: "turn-status",
	description: "Report whether a turn is active for the given room.",
	async handler(req, res, runtime) {
		const params = (req.params ?? {}) as Record<string, unknown>;
		const roomId = typeof params.roomId === "string" ? params.roomId : "";
		if (!roomId) {
			res.status(400).json({ error: "roomId required" });
			return;
		}
		const active = runtime.turnControllers.hasActiveTurn(roomId);
		const hasSignal = runtime.turnControllers.signalFor(roomId) !== null;
		res.status(200).json({ roomId, active, hasSignal });
	},
};

export const TURN_CONTROL_ROUTES: ReadonlyArray<Route> = [
	TURN_ABORT_ROUTE,
	TURN_STATUS_ROUTE,
];
