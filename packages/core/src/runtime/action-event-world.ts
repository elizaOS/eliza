/**
 * Resolves the world namespace attached to action lifecycle diagnostics. A
 * message world is authoritative; otherwise the room owns the lookup, and a
 * reported failure falls back to the agent's canonical default world without
 * substituting the unrelated room UUID.
 */

import { ElizaError } from "../errors";
import type { IAgentRuntime, Memory, UUID } from "../types";

type ActionEventWorldRuntime = Pick<
	IAgentRuntime,
	"agentId" | "getRoom" | "reportError"
>;

type ActionEventWorldMessage = Pick<Memory, "roomId" | "worldId">;

export async function resolveActionEventWorldId(
	runtime: ActionEventWorldRuntime,
	message: ActionEventWorldMessage,
	reportScope: string,
): Promise<UUID> {
	if (message.worldId) {
		return message.worldId;
	}

	let room: Awaited<ReturnType<ActionEventWorldRuntime["getRoom"]>>;
	try {
		room = await runtime.getRoom(message.roomId);
	} catch (cause: unknown) {
		// error-policy:J7 lifecycle events are diagnostics and must not abort an
		// action; report the failed lookup and use the agent's default world.
		runtime.reportError(
			reportScope,
			new ElizaError("Action event world lookup failed", {
				code: "ACTION_EVENT_WORLD_LOOKUP_FAILED",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
				severity: "ephemeral",
				context: { roomId: message.roomId },
			}),
		);
		return runtime.agentId;
	}

	if (!room) {
		runtime.reportError(
			reportScope,
			new ElizaError("Action event room was not found", {
				code: "ACTION_EVENT_ROOM_NOT_FOUND",
				severity: "ephemeral",
				context: { roomId: message.roomId },
			}),
		);
		return runtime.agentId;
	}

	if (!room.worldId) {
		runtime.reportError(
			reportScope,
			new ElizaError("Action event room has no world", {
				code: "ACTION_EVENT_ROOM_WORLD_MISSING",
				severity: "ephemeral",
				context: { roomId: message.roomId },
			}),
		);
		return runtime.agentId;
	}

	return room.worldId;
}
