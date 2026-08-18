/**
 * Vector storage for memory embeddings. Each row belongs to exactly one
 * memory (enforced by the `embedding_source_check` CHECK constraint and a
 * cascading FK) and carries one populated `dimNNN` column matching the
 * embedding model's output width — the others stay null. Supporting multiple
 * fixed-width columns instead of a single variable-length vector lets
 * PostgreSQL index each dimension separately.
 *
 * Canonical BGE-small vectors deliberately live in separate physical tables
 * per pooling/version.
 * A still-running legacy binary can update or delete rows in `embeddings`, but
 * it cannot name (and therefore cannot corrupt) the versioned BGE table. The
 * adapter creates that table additively, outside migration snapshots.
 */
import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
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

/** Physical vector width for every adapter-selectable column. */
export const EMBEDDING_DIMENSION_BY_COLUMN = {
  dim384: VECTOR_DIMS.SMALL,
  dim512: VECTOR_DIMS.MEDIUM,
  dim768: VECTOR_DIMS.LARGE,
  dim1024: VECTOR_DIMS.XL,
  dim1536: VECTOR_DIMS.XXL,
  dim2048: VECTOR_DIMS.XXL2,
  dim3072: VECTOR_DIMS.XXXL,
} as const;

/** Migration-facing legacy shape. */
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

/**
 * Legacy mean-pooled BGE space retained only for safe upgrade detection. This
 * symbol stays out of `schema/index.ts`; the adapter creates the physical table
 * additively so migration snapshots remain compatible with older binaries.
 */
export const bgeSmallEnV15EmbeddingTable = pgTable("embeddings_bge_small_en_v1_5", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  memoryId: uuid("memory_id")
    .references(() => memoryTable.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  createdAt: timestamp("created_at").default(sql`now()`).notNull(),
  sourceText: text("source_text"),
  dim384: vector("embedding", { dimensions: VECTOR_DIMS.SMALL }).notNull(),
});

/**
 * Active BGE-small CLS + L2 v2 space. A new physical table is required even
 * though it is also 384-wide: a still-running mean-v1 binary can only name the
 * legacy BGE table, so it cannot overwrite or delete CLS vectors during a
 * rolling upgrade. Its `dim384` TypeScript property maps to the physical
 * `embedding` column so existing dimension-keyed adapter paths remain shared.
 */
export const bgeSmallEnV15ClsL2V2EmbeddingTable = pgTable(
  "embeddings_bge_small_en_v1_5_cls_l2_v2",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    memoryId: uuid("memory_id")
      .references(() => memoryTable.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    sourceText: text("source_text"),
    dim384: vector("embedding", { dimensions: VECTOR_DIMS.SMALL }).notNull(),
  }
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
