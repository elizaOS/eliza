import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the embeddings table.
 * Contains 6 vector columns for different dimensions (384, 512, 768, 1024, 1536, 3072).
 */
export const embeddingSchema: SchemaTable = {
	name: "embeddings",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "defaultRandom()",
		},
		memory_id: {
			name: "memory_id",
			type: "uuid",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		dim_384: {
			name: "dim_384",
			type: "vector(384)",
		},
		dim_512: {
			name: "dim_512",
			type: "vector(512)",
		},
		dim_768: {
			name: "dim_768",
			type: "vector(768)",
		},
		dim_1024: {
			name: "dim_1024",
			type: "vector(1024)",
		},
		dim_1536: {
			name: "dim_1536",
			type: "vector(1536)",
		},
		dim_3072: {
			name: "dim_3072",
			type: "vector(3072)",
		},
	},
	indexes: {
		idx_embedding_memory: {
			name: "idx_embedding_memory",
			columns: [{ expression: "memory_id", isExpression: false }],
			// WHY: Unique constraint (unique_embedding_memory) guarantees 1:1 memory→embedding.
			// This index is kept for explicit FK lookups; the unique constraint also creates
			// an implicit unique index, so this could be dropped. Kept for clarity.
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_embedding_memory: {
			name: "fk_embedding_memory",
			tableFrom: "embeddings",
			tableTo: "memories",
			columnsFrom: ["memory_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		// WHY: upsertMemories uses ON CONFLICT (memory_id) to update the embedding
		// vector when a memory's content changes. Without this unique constraint,
		// ON CONFLICT would fail ("no unique or exclusion constraint matching...")
		// and ON DUPLICATE KEY UPDATE would never trigger (PK is always new UUID).
		unique_embedding_memory: {
			name: "unique_embedding_memory",
			columns: ["memory_id"],
		},
	},
	checkConstraints: {
		embedding_source_check: {
			name: "embedding_source_check",
			value: '"memory_id" IS NOT NULL',
		},
	},
};
