import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the rooms table.
 */
export const roomSchema: SchemaTable = {
	name: "rooms",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
		},
		source: {
			name: "source",
			type: "text",
			notNull: true,
		},
		type: {
			name: "type",
			type: "text",
			notNull: true,
		},
		message_server_id: {
			name: "message_server_id",
			type: "uuid",
		},
		world_id: {
			name: "world_id",
			type: "uuid",
		},
		name: {
			name: "name",
			type: "text",
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
		},
		channel_id: {
			name: "channel_id",
			type: "text",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {
		// WHY: Every room query is agent-scoped (getRoomsByIds, getRoomsForParticipant,
		// deleteRoomsByWorldId, getAgentRunSummaries via JOIN).
		idx_rooms_agent: {
			name: "idx_rooms_agent",
			columns: [{ expression: "agent_id", isExpression: false }],
			isUnique: false,
		},
		// WHY: World-scoped room lookups (getRoomsByWorld, deleteRoomsByWorldId,
		// getMemoriesByWorldId via JOIN).
		idx_rooms_world: {
			name: "idx_rooms_world",
			columns: [{ expression: "world_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_room_agent: {
			name: "fk_room_agent",
			tableFrom: "rooms",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
