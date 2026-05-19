import type {
	ChannelType,
	Entity,
	IAgentRuntime,
	Metadata,
	Room,
	UUID,
	World,
} from "@elizaos/core";

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
	roomName?: string;
	userName?: string;
	name?: string;
	worldName?: string;
	source?: string;
	channelId?: string;
	serverId?: string;
	messageServerId?: UUID;
	type?: ChannelType | string;
	worldId?: UUID;
	userId?: UUID;
	metadata?: Metadata;
}

export interface ICompatRuntime
	extends Omit<
		IAgentRuntime,
		| "ensureWorldExists"
		| "ensureRoomExists"
		| "ensureConnection"
		| "ensureConnections"
	> {
	ensureWorldExists(world: WorldCompat): Promise<void>;
	ensureRoomExists(room: RoomCompat): Promise<void>;
	ensureConnection(params: EnsureConnectionParams): Promise<void>;
	ensureConnections(
		entities: Entity[],
		rooms: RoomCompat[],
		source: string,
		world: WorldCompat,
	): Promise<void>;
}
