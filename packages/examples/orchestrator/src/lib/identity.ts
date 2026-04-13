import { stringToUuid, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidString(value: string): value is UUID {
  return UUID_REGEX.test(value);
}

/**
 * Stable per-project identity values used to keep runtime memory and task state
 * consistent across process restarts (TUI + non-interactive CLI).
 */
export interface SessionIdentity {
  /** Random per-project identifier (persisted to `.eliza-code/session.json`). */
  projectId: UUID;
  /** The "user entity" id used for messages sent from this CLI/TUI. */
  userId: UUID;
  /** World id used to group rooms/tasks for this project. */
  worldId: UUID;
  /** Optional message server id used by core messaging/world helpers. */
  messageServerId: UUID;
}

export type PartialSessionIdentity = Partial<SessionIdentity>;

export function ensureSessionIdentity(
  input: PartialSessionIdentity = {},
): SessionIdentity {
  const projectId =
    input.projectId && isUuidString(input.projectId)
      ? input.projectId
      : (uuidv4() as UUID);
  const userId =
    input.userId && isUuidString(input.userId)
      ? input.userId
      : (uuidv4() as UUID);
  const worldId =
    input.worldId && isUuidString(input.worldId)
      ? input.worldId
      : stringToUuid(`eliza-code:world:${projectId}`);
  const messageServerId =
    input.messageServerId && isUuidString(input.messageServerId)
      ? input.messageServerId
      : stringToUuid(`eliza-code:server:${projectId}`);

  return { projectId, userId, worldId, messageServerId };
}

export function createRoomElizaId(identity: SessionIdentity): UUID {
  // We deliberately derive this from (projectId + random) so it is:
  // - unique within a project
  // - stable across restarts once persisted in the session file
  return stringToUuid(`eliza-code:room:${identity.projectId}:${uuidv4()}`);
}

export function getMainRoomElizaId(identity: SessionIdentity): UUID {
  return stringToUuid(`eliza-code:room:${identity.projectId}:main`);
}
