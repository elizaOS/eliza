/**
 * Runtime compatibility layer for old/new core.
 *
 * Automatically adds serverId when messageServerId is provided,
 * making plugin code work with both core versions unchanged.
 *
 * Old core expects: serverId (string)
 * New core expects: messageServerId (UUID)
 *
 * NOTE: UUID function usage for Discord IDs:
 * - `stringToUuid(str)` - CONVERTS any string to a deterministic UUID by hashing.
 *   Use this for Discord snowflake IDs (always succeeds, same input = same output).
 * - `asUUID(str)` - VALIDATES that string is already a valid UUID format.
 *   Throws if not a valid UUID. Only use when input is already a UUID.
 *
 * REMOVAL: Delete this file and remove createCompatRuntime() call in service.ts
 */
import type { ChannelType, Entity, IAgentRuntime, Room, UUID, World } from "@elizaos/core";

/**
 * Extended types that support messageServerId for cross-core compatibility.
 * These allow TypeScript to accept messageServerId in object literals.
 */
export type WorldCompat = Omit<World, "serverId"> & {
  serverId?: string;
  messageServerId?: UUID;
};

export type RoomCompat = Omit<Room, "serverId"> & {
  serverId?: string;
  messageServerId?: UUID;
};

export interface EnsureConnectionParams {
  entityId: UUID;
  roomId: UUID;
  userName?: string;
  name?: string;
  worldName?: string;
  source?: string;
  channelId?: string;
  serverId?: string;
  messageServerId?: UUID;
  type?: ChannelType | string;
  worldId: UUID;
  userId?: UUID;
  metadata?: Record<string, unknown>;
}

/**
 * Extended runtime interface that accepts messageServerId in method parameters.
 */
export interface ICompatRuntime
  extends Omit<
    IAgentRuntime,
    "ensureWorldExists" | "ensureRoomExists" | "ensureConnection" | "ensureConnections"
  > {
  ensureWorldExists(world: WorldCompat): Promise<void>;
  ensureRoomExists(room: RoomCompat): Promise<void>;
  ensureConnection(params: EnsureConnectionParams): Promise<void>;
  ensureConnections(
    entities: Entity[],
    rooms: RoomCompat[],
    source: string,
    world: WorldCompat
  ): Promise<void>;
}

function addServerId<T extends Record<string, unknown>>(obj: T): T {
  if (!obj?.messageServerId) {
    return obj;
  }
  return { ...obj, serverId: obj.serverId ?? obj.messageServerId };
}

export function createCompatRuntime(runtime: IAgentRuntime): ICompatRuntime {
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (prop === "ensureWorldExists") {
        return (world: unknown) =>
          value.call(target, addServerId(world as Record<string, unknown>));
      }
      if (prop === "ensureRoomExists") {
        return (room: unknown) => value.call(target, addServerId(room as Record<string, unknown>));
      }
      if (prop === "ensureConnection") {
        return (params: unknown) =>
          value.call(target, addServerId(params as Record<string, unknown>));
      }
      if (prop === "ensureConnections") {
        return (entities: unknown[], rooms: unknown[], source: string, world: unknown) =>
          value.call(
            target,
            entities,
            rooms.map((r) => addServerId(r as Record<string, unknown>)),
            source,
            addServerId(world as Record<string, unknown>)
          );
      }

      return value;
    },
  });
}
