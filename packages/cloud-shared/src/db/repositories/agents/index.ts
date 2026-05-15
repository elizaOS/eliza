/**
 * Agent repositories index.
 *
 * Direct database access to elizaOS tables without spinning up runtime.
 */

/**
 * Re-exported core types from elizaOS.
 */
export type { Entity, Memory, Participant } from "@elizaos/core";
export type { AgentInfo } from "./agents";
export { agentsRepository } from "./agents";
export type { CreateEntityInput } from "./entities";

export { entitiesRepository } from "./entities";
export type { CreateMemoryInput, SearchMemoriesOptions } from "./memories";

export { memoriesRepository } from "./memories";
export type { CreateParticipantInput } from "./participants";
export { participantsRepository } from "./participants";
export type {
  CreateRoomInput,
  Room,
  RoomWithPreview,
  UpdateRoomInput,
} from "./rooms";
export { roomsRepository } from "./rooms";
