import type {
  Content,
  CustomMetadata,
  IAgentRuntime,
  Memory,
  MemoryMetadata,
  UUID,
} from "@elizaos/core";
import { ChannelType, MemoryType, Service, stringToUuid } from "@elizaos/core";

export const WAYPOINTS_SERVICE_TYPE = "minecraft_waypoints" as const;

export type Waypoint = {
  id: UUID;
  name: string;
  x: number;
  y: number;
  z: number;
  createdAt: Date;
};

type WaypointMetadata = CustomMetadata & {
  waypointType: "minecraft_waypoint";
  waypointName: string;
  x: number;
  y: number;
  z: number;
};

export class WaypointsService extends Service {
  static serviceType = WAYPOINTS_SERVICE_TYPE;
  capabilityDescription = "Minecraft waypoint storage and navigation helpers";

  private waypoints = new Map<string, Waypoint>();
  private waypointsRoomId: UUID;
  private waypointsWorldId: UUID;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new Error("WaypointsService requires a runtime");
    }
    this.runtime = runtime;

    // Dedicated context for waypoint persistence.
    this.waypointsWorldId = stringToUuid(
      "00000000-0000-0000-0000-00000000a001",
    );
    this.waypointsRoomId = stringToUuid(
      `minecraft-waypoints:${runtime.agentId}`,
    );
  }

  static async start(runtime: IAgentRuntime): Promise<WaypointsService> {
    const service = new WaypointsService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    // In-memory only; nothing to tear down.
  }

  private async initialize(): Promise<void> {
    // Ensure the world/room exist when supported (so memories are properly scoped).
    if (this.runtime.ensureWorldExists) {
      await this.runtime.ensureWorldExists({
        id: this.waypointsWorldId,
        name: "Minecraft Waypoints",
        agentId: this.runtime.agentId,
        messageServerId: stringToUuid("00000000-0000-0000-0000-000000000000"),
        metadata: {
          type: "minecraft",
          description: "Persistent waypoint storage",
        },
      });
    }
    if (this.runtime.ensureRoomExists) {
      await this.runtime.ensureRoomExists({
        id: this.waypointsRoomId,
        name: "Minecraft Waypoints",
        worldId: this.waypointsWorldId,
        source: "plugin-minecraft",
        type: ChannelType.SELF,
        metadata: {
          type: "minecraft",
          description: "Persistent waypoint storage",
        },
      });
    }
    if (this.runtime.ensureParticipantInRoom) {
      await this.runtime.ensureParticipantInRoom(
        this.runtime.agentId,
        this.waypointsRoomId,
      );
    }

    // Load existing waypoint memories (persisted by plugin-sql or any durable adapter).
    const memories = await this.runtime.getMemories({
      roomId: this.waypointsRoomId,
      count: 500,
      tableName: "memories",
    });

    for (const m of memories) {
      const md = m.metadata;
      if (!md || md.type !== MemoryType.CUSTOM) continue;
      const cmd = md as WaypointMetadata;
      if (cmd.waypointType !== "minecraft_waypoint") continue;
      if (typeof cmd.waypointName !== "string") continue;
      if (
        typeof cmd.x !== "number" ||
        typeof cmd.y !== "number" ||
        typeof cmd.z !== "number"
      )
        continue;

      const key = cmd.waypointName.trim().toLowerCase();
      const createdAt =
        typeof m.createdAt === "number" ? new Date(m.createdAt) : new Date();
      const id =
        m.id ?? stringToUuid(`mc-waypoint:${this.runtime.agentId}:${key}`);
      this.waypoints.set(key, {
        id,
        name: cmd.waypointName,
        x: cmd.x,
        y: cmd.y,
        z: cmd.z,
        createdAt,
      });
    }
  }

  private waypointIdForKey(key: string): UUID {
    return stringToUuid(`mc-waypoint:${this.runtime.agentId}:${key}`);
  }

  private buildWaypointMemory(_key: string, wp: Waypoint): Memory {
    const createdAt = Date.now();
    const content: Content = {
      text: `Waypoint "${wp.name}" at (${wp.x}, ${wp.y}, ${wp.z})`,
      source: "plugin-minecraft",
    };
    const metadata: WaypointMetadata = {
      type: MemoryType.CUSTOM,
      scope: "private",
      waypointType: "minecraft_waypoint",
      waypointName: wp.name,
      x: wp.x,
      y: wp.y,
      z: wp.z,
      tags: ["minecraft", "waypoint"],
      timestamp: createdAt,
    };

    return {
      id: wp.id,
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: this.waypointsRoomId,
      worldId: this.waypointsWorldId,
      createdAt,
      content,
      metadata: metadata as MemoryMetadata,
      unique: true,
    };
  }

  async setWaypoint(
    name: string,
    x: number,
    y: number,
    z: number,
  ): Promise<Waypoint> {
    const key = name.trim().toLowerCase();
    const wp: Waypoint = {
      id: this.waypointIdForKey(key),
      name: name.trim(),
      x,
      y,
      z,
      createdAt: new Date(),
    };
    this.waypoints.set(key, wp);

    const memory = this.buildWaypointMemory(key, wp);
    // Upsert as a memory record; durable when plugin-sql (or another durable adapter) is enabled.
    const existing = await this.runtime.getMemories({
      roomId: this.waypointsRoomId,
      count: 1,
      tableName: "memories",
    });
    if (existing.some((m) => m.id === wp.id)) {
      await this.runtime.updateMemory({
        id: wp.id,
        content: memory.content,
        metadata: memory.metadata,
      });
    } else {
      await this.runtime.createMemory(memory, "memories", true);
    }

    return wp;
  }

  async deleteWaypoint(name: string): Promise<boolean> {
    const key = name.trim().toLowerCase();
    const wp = this.waypoints.get(key);
    const deleted = this.waypoints.delete(key);
    if (wp) {
      await this.runtime.deleteMemory(wp.id);
    }
    return deleted;
  }

  getWaypoint(name: string): Waypoint | null {
    const key = name.trim().toLowerCase();
    return this.waypoints.get(key) ?? null;
  }

  listWaypoints(): Waypoint[] {
    return Array.from(this.waypoints.values()).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }
}
