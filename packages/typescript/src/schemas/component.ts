import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the components table.
 * Has multiple foreign keys to entities, agents, rooms, worlds.
 */
export const componentSchema: SchemaTable = {
	name: "components",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		entity_id: {
			name: "entity_id",
			type: "uuid",
			notNull: true,
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		room_id: {
			name: "room_id",
			type: "uuid",
			notNull: true,
		},
		world_id: {
			name: "world_id",
			type: "uuid",
		},
		source_entity_id: {
			name: "source_entity_id",
			type: "uuid",
		},
		type: {
			name: "type",
			type: "text",
			notNull: true,
		},
		data: {
			name: "data",
			type: "jsonb",
			default: "{}",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {
		// WHY: getComponent and getComponents filter by entity_id + type.
		// This is the most common access pattern for retrieving specific
		// component types for an entity (e.g., profile data, settings).
		idx_components_entity_type: {
			name: "idx_components_entity_type",
			columns: [
				{ expression: "entity_id", isExpression: false },
				{ expression: "type", isExpression: false },
			],
			isUnique: false,
		},
		// WHY: getEntitiesByIds JOINs components and filters by agent_id.
		// Also supports agent-scoped entity listings.
		idx_components_agent_entity: {
			name: "idx_components_agent_entity",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "entity_id", isExpression: false },
			],
			isUnique: false,
		},
		// WHY: World-scoped component lookups (e.g., "find all components in
		// this world") used by getEntitiesByIds when world filtering is applied.
		idx_components_world: {
			name: "idx_components_world",
			columns: [{ expression: "world_id", isExpression: false }],
			isUnique: false,
		},
		// WHY: queryEntities uses JSONB containment (@>) to filter components by data.
		// GIN index with jsonb_path_ops is 2-3x smaller and faster for @> queries.
		// Used for queries like "find all ACCOUNT components where data.chain = 'solana'"
		idx_components_data_gin: {
			name: "idx_components_data_gin",
			columns: [{ expression: "data jsonb_path_ops", isExpression: true }],
			isUnique: false,
			method: "gin",
		},
	},
	foreignKeys: {
		fk_component_entity: {
			name: "fk_component_entity",
			tableFrom: "components",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_component_agent: {
			name: "fk_component_agent",
			tableFrom: "components",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_component_room: {
			name: "fk_component_room",
			tableFrom: "components",
			tableTo: "rooms",
			columnsFrom: ["room_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_component_world: {
			name: "fk_component_world",
			tableFrom: "components",
			tableTo: "worlds",
			columnsFrom: ["world_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_component_source_entity: {
			name: "fk_component_source_entity",
			tableFrom: "components",
			tableTo: "entities",
			columnsFrom: ["source_entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		// WHY: Components have a natural key of (entity_id, type, world_id, source_entity_id).
		// Without this constraint, multiple components with the same natural key can exist,
		// breaking the semantic model. NULLS NOT DISTINCT ensures that NULLs are treated
		// as equal (PG 15+), so (entity1, 'ACCOUNT', NULL, NULL) is unique.
		// This enables upsertComponents to use ON CONFLICT for idempotent upserts.
		unique_component_natural_key: {
			name: "unique_component_natural_key",
			columns: ["entity_id", "type", "world_id", "source_entity_id"],
			nullsNotDistinct: true,
		},
	},
	checkConstraints: {},
};
