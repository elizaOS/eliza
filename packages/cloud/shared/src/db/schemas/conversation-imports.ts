// Defines the conversation-import Drizzle tables (batches, resumable upload sessions, artifacts) used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * One conversation-import batch per uploaded export. The batch is the tenant
 * lifecycle anchor for #13432: raw uploads and derived artifacts hang off it,
 * quota reservations are tracked on it, and batch delete removes everything
 * scoped to it.
 */
export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    api_key_id: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    /** Safe path component scoping artifacts under the tenant (defaults to "default"). */
    app_id: text("app_id").notNull(),
    /** Export source declared at init (chatgpt | claude | hermes | openclaw | …). */
    source: text("source").notNull(),
    /** uploading | uploaded | aborted | deleted */
    status: text("status").notNull().default("uploading"),
    /** Declared raw upload size in bytes; the resumable transport enforces it chunk by chunk. */
    upload_bytes: bigint("upload_bytes", { mode: "bigint" }).notNull(),
    /**
     * Storage-quota bytes still reserved by the in-flight upload. Transferred
     * to the raw-upload artifact at complete (set to 0) and released on abort.
     */
    reserved_bytes: bigint("reserved_bytes", { mode: "bigint" }).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    deleted_at: timestamp("deleted_at"),
  },
  (table) => ({
    organization_idx: index("import_batches_organization_idx").on(table.organization_id),
    org_status_created_idx: index("import_batches_org_status_created_idx").on(
      table.organization_id,
      table.status,
      table.created_at,
    ),
  }),
);

/**
 * Resumable chunk-upload session state for large (100MB–1GB class) imports.
 * `session_state` is the serialized `ResumableUploadSession` from
 * `@elizaos/import-conversations` — the pure core primitive validates every
 * chunk (index/offset/length/sha256) and this row just persists it between
 * Worker requests, alongside the R2 multipart bookkeeping.
 */
export const importUploadSessions = pgTable(
  "import_upload_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    batch_id: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    content_type: text("content_type").notNull(),
    /** Whole-file sha256 declared by the client at init; used as the raw object's content address. */
    declared_sha256: text("declared_sha256").notNull(),
    upload_bytes: bigint("upload_bytes", { mode: "bigint" }).notNull(),
    chunk_size: integer("chunk_size").notNull(),
    chunk_count: integer("chunk_count").notNull(),
    /** open | complete | aborted */
    status: text("status").notNull().default("open"),
    /** R2 multipart upload id backing this session. */
    multipart_upload_id: text("multipart_upload_id").notNull(),
    /** Destination object key (tenant/app/batch scoped, content-addressed by declared sha). */
    storage_key: text("storage_key").notNull(),
    /** Serialized core ResumableUploadSession (chunk map + progress). */
    session_state: jsonb("session_state").$type<Record<string, unknown>>().notNull(),
    /** R2 part etags keyed by canonical part number (chunk index + 1). */
    part_etags: jsonb("part_etags").$type<Record<string, string>>().notNull().default({}),
    /** Explicit longer raw retention requested at init (requires a reason). */
    retain_raw: boolean("retain_raw").notNull().default(false),
    retain_reason: text("retain_reason"),
    /** Interrupted uploads expire; the retention sweep aborts them and releases quota. */
    expires_at: timestamp("expires_at").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("import_upload_sessions_organization_idx").on(table.organization_id),
    batch_idx: index("import_upload_sessions_batch_idx").on(table.batch_id),
    status_expires_idx: index("import_upload_sessions_status_expires_idx").on(
      table.status,
      table.expires_at,
    ),
  }),
);

/**
 * Content-addressed import artifacts (raw uploads + derived outputs) tied to a
 * batch lifecycle. Retention follows the core artifact policy: raw uploads are
 * short-lived by default (`expires_at` set), explicit raw retention carries a
 * reason, derived artifacts delete with the batch.
 */
export const importArtifacts = pgTable(
  "import_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    batch_id: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    /** raw-upload | derived-document | derived-manifest | import-report */
    kind: text("kind").notNull(),
    sha256: text("sha256").notNull(),
    byte_length: bigint("byte_length", { mode: "bigint" }).notNull(),
    content_type: text("content_type").notNull(),
    storage_key: text("storage_key").notNull(),
    /** short-lived | explicit-raw-retain | batch-lifecycle */
    retention_mode: text("retention_mode").notNull(),
    /** Required when retention_mode = explicit-raw-retain. */
    retain_reason: text("retain_reason"),
    /** Set when retention_mode = short-lived; the sweep purges past-due rows. */
    expires_at: timestamp("expires_at"),
    /** active | deleted */
    status: text("status").notNull().default("active"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    deleted_at: timestamp("deleted_at"),
  },
  (table) => ({
    organization_idx: index("import_artifacts_organization_idx").on(table.organization_id),
    batch_status_idx: index("import_artifacts_batch_status_idx").on(table.batch_id, table.status),
    status_expires_idx: index("import_artifacts_status_expires_idx").on(
      table.status,
      table.expires_at,
    ),
    sha_idx: index("import_artifacts_sha_idx").on(table.sha256),
  }),
);

export type ImportBatch = InferSelectModel<typeof importBatches>;
export type NewImportBatch = InferInsertModel<typeof importBatches>;
export type ImportUploadSessionRow = InferSelectModel<typeof importUploadSessions>;
export type NewImportUploadSessionRow = InferInsertModel<typeof importUploadSessions>;
export type ImportArtifactRow = InferSelectModel<typeof importArtifacts>;
export type NewImportArtifactRow = InferInsertModel<typeof importArtifacts>;
