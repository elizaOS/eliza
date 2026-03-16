/**
 * Agent repositories index.
 *
 * Direct database access to elizaOS tables without spinning up runtime.
 */

export { roomsRepository } from "./rooms";
export type {
  Room,
  RoomWithPreview,
  CreateRoomInput,
  UpdateRoomInput,
} from "./rooms";

export { participantsRepository } from "./participants";
export type { CreateParticipantInput } from "./participants";

export { entitiesRepository } from "./entities";
export type { CreateEntityInput } from "./entities";

export { memoriesRepository } from "./memories";
export type { CreateMemoryInput, SearchMemoriesOptions } from "./memories";

export { agentsRepository } from "./agents";
export type { AgentInfo } from "./agents";

/**
 * Re-exported core types from elizaOS.
 */
export type { Participant, Entity, Memory } from "@elizaos/core";
