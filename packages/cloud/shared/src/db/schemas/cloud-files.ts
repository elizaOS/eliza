import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { generations } from "./generations";
import { organizations } from "./organizations";
import { users } from "./users";

export const cloudFiles = pgTable(
  "cloud_files",
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
    generation_id: uuid("generation_id").references(() => generations.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    mime_type: text("mime_type").notNull(),
    size_bytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    sha256: text("sha256").notNull(),
    storage_key: text("storage_key").notNull(),
    storage_url: text("storage_url").notNull(),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    deleted_at: timestamp("deleted_at"),
  },
  (table) => ({
    organization_idx: index("cloud_files_organization_idx").on(table.organization_id),
    org_status_created_idx: index("cloud_files_org_status_created_idx").on(
      table.organization_id,
      table.status,
      table.created_at,
    ),
    org_kind_status_idx: index("cloud_files_org_kind_status_idx").on(
      table.organization_id,
      table.kind,
      table.status,
    ),
    generation_idx: index("cloud_files_generation_idx").on(table.generation_id),
    sha_idx: index("cloud_files_sha_idx").on(table.sha256),
  }),
);

export type CloudFile = InferSelectModel<typeof cloudFiles>;
export type NewCloudFile = InferInsertModel<typeof cloudFiles>;
