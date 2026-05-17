import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps, userDatabaseStatusEnum } from "./apps";

/**
 * App databases table schema.
 *
 * Canonical storage for app database provisioning state.
 *
 * Stores Neon/shared database provisioning state for stateful apps.
 * Split from the main apps table to reduce row size on the heavily-read core table.
 */
export const appDatabases = pgTable(
  "app_databases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .unique()
      .references(() => apps.id, { onDelete: "cascade" }),

    /**
     * Encrypted connection URI to the user's provisioned Neon database.
     * SENSITIVE: Never expose to client code or logs.
     */
    user_database_uri: text("user_database_uri"),

    /** Neon project ID for API operations. */
    user_database_project_id: text("user_database_project_id"),

    /** Neon branch ID (primary branch). */
    user_database_branch_id: text("user_database_branch_id"),

    /** Provisioning target region recorded for compatibility; not used for DB read routing. */
    user_database_region: text("user_database_region").default("aws-us-east-1"),

    /** Current provisioning status. State machine: none → provisioning → ready | error. */
    user_database_status: userDatabaseStatusEnum("user_database_status").notNull().default("none"),

    /** Error message if provisioning failed. */
    user_database_error: text("user_database_error"),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    app_idx: index("app_databases_app_idx").on(table.app_id),
    status_idx: index("app_databases_status_idx").on(table.user_database_status),
  }),
);

// Type inference
export type AppDatabase = InferSelectModel<typeof appDatabases>;
export type NewAppDatabase = InferInsertModel<typeof appDatabases>;
