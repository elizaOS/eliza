/**
 * HTTP routes for turn control.
 *
 * Exposes the turn-scoped AbortController registry over a small HTTP surface
 * so UI stop buttons, connector cancel-on-typing, and external orchestrators
 * can abort the agent's in-flight work for a given room.
 *
 * Routes:
 *   POST /api/turns/:roomId/abort
 *     body: { reason?: string }
 *     200 { aborted: true }   — the active turn was aborted
 *     200 { aborted: false }  — no active turn (idempotent)
 *
 *   GET /api/turns/:roomId
 *     200 { active: boolean, hasSignal: boolean }
 *
 * Registered by the basic-capabilities plugin so every runtime gets them.
 */

import type { Route } from "../types/plugin";

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
		const aborted = runtime.turnControllers.abortTurn(roomId, reason);
		res.status(200).json({ aborted, roomId, reason });
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
