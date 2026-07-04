/**
 * Vector storage for memory embeddings. Each row belongs to exactly one
 * memory (enforced by the `embedding_source_check` CHECK constraint and a
 * cascading FK) and carries one populated `dimNNN` column matching the
 * embedding model's output width — the others stay null. Supporting multiple
 * fixed-width columns instead of a single variable-length vector lets
 * PostgreSQL index each dimension separately.
 */
import { relations, sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, timestamp, uuid, vector } from "drizzle-orm/pg-core";
import { memoryTable } from "./memory";

export const VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  // 2048: retained for local Eliza-1 pooled-text embeddings and other
  // 2048-wide local providers. Without this column those embeddings have no
  // storable dimension and are silently dropped (broken on-device memory/RAG).
  XXL2: 2048,
  XXXL: 3072,
} as const;

export const DIMENSION_MAP = {
  [VECTOR_DIMS.SMALL]: "dim384",
  [VECTOR_DIMS.MEDIUM]: "dim512",
  [VECTOR_DIMS.LARGE]: "dim768",
  [VECTOR_DIMS.XL]: "dim1024",
  [VECTOR_DIMS.XXL]: "dim1536",
  [VECTOR_DIMS.XXL2]: "dim2048",
  [VECTOR_DIMS.XXXL]: "dim3072",
} as const;

export const embeddingTable = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    memoryId: uuid("memory_id").references(() => memoryTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    dim384: vector("dim_384", { dimensions: VECTOR_DIMS.SMALL }),
    dim512: vector("dim_512", { dimensions: VECTOR_DIMS.MEDIUM }),
    dim768: vector("dim_768", { dimensions: VECTOR_DIMS.LARGE }),
    dim1024: vector("dim_1024", { dimensions: VECTOR_DIMS.XL }),
    dim1536: vector("dim_1536", { dimensions: VECTOR_DIMS.XXL }),
    dim2048: vector("dim_2048", { dimensions: VECTOR_DIMS.XXL2 }),
    dim3072: vector("dim_3072", { dimensions: VECTOR_DIMS.XXXL }),
  },
  (table) => [
    check("embedding_source_check", sql`"memory_id" IS NOT NULL`),
    index("idx_embedding_memory").on(table.memoryId),
    foreignKey({
      name: "fk_embedding_memory",
      columns: [table.memoryId],
      foreignColumns: [memoryTable.id],
    }).onDelete("cascade"),
  ]
);

/** Column names for each supported embedding width. */
export type EmbeddingDimensionColumn =
  | "dim384"
  | "dim512"
  | "dim768"
  | "dim1024"
  | "dim1536"
  | "dim2048"
  | "dim3072";

/** Drizzle column type for a given `EmbeddingDimensionColumn` key. */
export type EmbeddingTableColumn = (typeof embeddingTable._.columns)[EmbeddingDimensionColumn];

/** Defined here, not in memory.ts, to avoid a circular import between the two schema files. */
export const memoryRelations = relations(memoryTable, ({ one }) => ({
  embedding: one(embeddingTable),
}));
