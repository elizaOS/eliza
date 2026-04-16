/**
 * Task heartbeat — one "still working" chat ping per user prompt, per
 * originating room. Fires once when any PTY session in the room has been
 * running longer than {@link HEARTBEAT_AFTER_MS}; never again until all
 * sessions in that room end (at which point the next user prompt starts
 * fresh).
 *
 * Silent for autonomous sessions (no originating roomId) so background
 * coordinator work doesn't spam chat.
 *
 * @module runtime/task-heartbeat
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";

/** Time before the heartbeat fires for a freshly-started prompt. */
const HEARTBEAT_AFTER_MS = 45_000;

interface PTYServiceWithEvents {
	onSessionEvent: (
		cb: (sessionId: string, event: string, data: unknown) => void,
	) => () => void;
	sessionMetadata?: Map<string, Record<string, unknown>>;
}

interface RuntimeWithMessageTarget extends IAgentRuntime {
	sendMessageToTarget: (
		target: { source?: string; roomId?: UUID; channelId?: string },
		message: { text: string; source?: string },
	) => Promise<unknown>;
	getRoom: (
		roomId: UUID,
	) => Promise<{ channelId?: string; source?: string } | null>;
}

interface RoomState {
	startedAt: number;
	sessionIds: Set<string>;
	heartbeatPosted: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Install the heartbeat on a PTY service. Returns a disposer that
 * unsubscribes the listener. No-op when the service does not expose the
 * event API (tests, mocks).
 */
export function installTaskHeartbeat(
	runtime: IAgentRuntime,
	ptyService: unknown,
): () => void {
	// `ptyService` comes from runtime.getService("PTY_SERVICE") which returns
	// the generic Service type. Shape-check at runtime before trusting the
	// structural PTYServiceWithEvents interface.
	const svc = ptyService as PTYServiceWithEvents | undefined;
	if (!svc || typeof svc.onSessionEvent !== "function") {
		return () => {};
	}

	// One state entry per originating room. A room stays tracked for the
	// lifetime of the user's prompt — first session creates it, last session
	// ending deletes it. The heartbeat fires at most once per room lifetime.
	const rooms = new Map<string, RoomState>();

	const getRoomId = (sessionId: string): string | null => {
		const meta = svc.sessionMetadata?.get(sessionId);
		return typeof meta?.roomId === "string" ? meta.roomId : null;
	};

	const fire = async (roomId: string): Promise<void> => {
		const state = rooms.get(roomId);
		if (!state || state.heartbeatPosted) return;
		state.heartbeatPosted = true;

		const room = await (runtime as RuntimeWithMessageTarget)
			.getRoom(roomId as UUID)
			.catch(() => null);
		if (!room?.channelId || !room.source) return;

		const seconds = Math.round((Date.now() - state.startedAt) / 1000);
		await (runtime as RuntimeWithMessageTarget).sendMessageToTarget(
			{ source: room.source, roomId: roomId as UUID, channelId: room.channelId },
			{ text: `still working — ${seconds}s in`, source: "task-heartbeat" },
		);
	};

	return svc.onSessionEvent((sessionId, event) => {
		const roomId = getRoomId(sessionId);
		if (!roomId) return;

		if (event === "stopped" || event === "task_complete" || event === "error") {
			const state = rooms.get(roomId);
			if (!state) return;
			state.sessionIds.delete(sessionId);
			if (state.sessionIds.size === 0) {
				if (state.timer) clearTimeout(state.timer);
				rooms.delete(roomId);
			}
			return;
		}

		const existing = rooms.get(roomId);
		if (existing) {
			existing.sessionIds.add(sessionId);
			return;
		}
		const state: RoomState = {
			startedAt: Date.now(),
			sessionIds: new Set([sessionId]),
			heartbeatPosted: false,
		};
		state.timer = setTimeout(() => {
			void fire(roomId).catch((err) => {
				logger.debug(
					`[task-heartbeat] fire failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}, HEARTBEAT_AFTER_MS);
		rooms.set(roomId, state);
	});
}
