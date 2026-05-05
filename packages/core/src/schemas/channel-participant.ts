import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the channel_participants table.
 * Composite primary key on (channel_id, entity_id).
 */
export const channelParticipantSchema: SchemaTable = {
	name: "channel_participants",
	schema: "",
	columns: {
		channel_id: {
			name: "channel_id",
			type: "text",
			notNull: true,
		},
		entity_id: {
			name: "entity_id",
			type: "text",
			notNull: true,
		},
	},
	indexes: {
		// WHY: The composite PK is (channel_id, entity_id), which covers
		// channel→entity lookups. But reverse lookups ("which channels is
		// this entity in?") need an index on entity_id alone.
		idx_cp_entity: {
			name: "idx_cp_entity",
			columns: [{ expression: "entity_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_channel_participant_channel: {
			name: "fk_channel_participant_channel",
			tableFrom: "channel_participants",
			tableTo: "channels",
			columnsFrom: ["channel_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {
		channel_participants_pk: {
			name: "channel_participants_pk",
			columns: ["channel_id", "entity_id"],
		},
	},
	uniqueConstraints: {},
	checkConstraints: {},
};
