import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the participants table.
 */
export const participantSchema: SchemaTable = {
	name: "participants",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		entity_id: {
			name: "entity_id",
			type: "uuid",
		},
		room_id: {
			name: "room_id",
			type: "uuid",
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
		},
		room_state: {
			name: "room_state",
			type: "text",
		},
	},
	indexes: {
		idx_participants_user: {
			name: "idx_participants_user",
			columns: [{ expression: "entity_id", isExpression: false }],
			isUnique: false,
		},
		idx_participants_room: {
			name: "idx_participants_room",
			columns: [{ expression: "room_id", isExpression: false }],
			isUnique: false,
		},
		// WHY: deleteParticipants and updateChannel diff-sync look up by the
		// compound (entity_id, room_id) pair. A unique index also enforces
		// the business rule that an entity can only participate in a room once.
		idx_participants_entity_room: {
			name: "idx_participants_entity_room",
			columns: [
				{ expression: "entity_id", isExpression: false },
				{ expression: "room_id", isExpression: false },
			],
			isUnique: true,
		},
		// WHY: Agent-scoped participant queries (e.g., "find all rooms this
		// agent's entities are in") need an index on agent_id.
		idx_participants_agent: {
			name: "idx_participants_agent",
			columns: [{ expression: "agent_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_room: {
			name: "fk_room",
			tableFrom: "participants",
			tableTo: "rooms",
			columnsFrom: ["room_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_user: {
			name: "fk_user",
			tableFrom: "participants",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
