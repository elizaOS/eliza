/**
 * Builds the storage context for SECRETS handlers.
 *
 * World-scoped operations must use Memory.worldId, never Memory.roomId.
 * Those IDs are distinct domains; using the room UUID stores and looks up
 * world secrets in the wrong partition.
 */

import type { IAgentRuntime, Memory } from "../../types/index.ts";
import type { SecretContext, SecretLevel } from "./types.ts";

export function secretContextFromMessage(
	runtime: Pick<IAgentRuntime, "agentId">,
	message: Pick<Memory, "worldId" | "entityId">,
	level: SecretLevel,
): SecretContext {
	return {
		level,
		agentId: runtime.agentId,
		worldId: level === "world" ? message.worldId : undefined,
		userId: level === "user" ? message.entityId : undefined,
		requesterId: message.entityId,
	};
}
