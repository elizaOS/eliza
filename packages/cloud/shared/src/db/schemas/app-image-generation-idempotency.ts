// Defines the app image generation idempotency Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { users } from "./users";

export const appImageGenerationIdempotency = pgTable(
  "app_image_generation_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    request_hash: text("request_hash").notNull(),
    status: text("status").notNull().default("processing"),
    charge_id: uuid("charge_id"),
    charge: jsonb("charge").$type<Record<string, unknown>>(),
    provider_result: jsonb("provider_result").$type<Record<string, unknown>>(),
    generation_ids: jsonb("generation_ids").$type<string[]>().default([]).notNull(),
    response_body: jsonb("response_body").$type<Record<string, unknown>>(),
    error_code: text("error_code"),
    expires_at: timestamp("expires_at").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    key_unique: uniqueIndex("app_image_generation_idempotency_key_idx").on(table.key),
    app_user_idx: index("app_image_generation_idempotency_app_user_idx").on(
      table.app_id,
      table.user_id,
    ),
    expires_idx: index("app_image_generation_idempotency_expires_idx").on(table.expires_at),
    status_idx: index("app_image_generation_idempotency_status_idx").on(table.status),
  }),
);

export type AppImageGenerationIdempotency = InferSelectModel<typeof appImageGenerationIdempotency>;
export type NewAppImageGenerationIdempotency = InferInsertModel<
  typeof appImageGenerationIdempotency
>;
