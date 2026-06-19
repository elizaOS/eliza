import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Tenant DB cluster pool (Apps / Product 2).
 *
 * Each row is one app-owned Postgres cluster that holds many per-tenant
 * databases (DATABASE-per-tenant + ROLE-per-tenant). The pool picks the
 * least-loaded active cluster with remaining capacity; when every cluster is
 * full, an operator adds another cluster row (+ box) and new tenants land
 * there — this "roll to a new cluster" is how we scale past any single
 * server's / managed-provider's database cap.
 *
 * This is the APPS data plane only — it has nothing to do with the shared
 * agent DATABASE_URL or `agent_sandboxes`.
 */
export const tenantDbClusters = pgTable(
  "tenant_db_clusters",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Backend kind: `direct_pg` (self-managed) or `neon`. */
    provider: text("provider").notNull().default("direct_pg"),

    /** Host[:port] used to build tenant DSNs (the data-plane endpoint). */
    host: text("host").notNull(),

    /**
     * Encrypted admin DSN used to run CREATE DATABASE / CREATE ROLE on this
     * cluster. SENSITIVE — never expose to client code or logs.
     */
    admin_dsn_encrypted: text("admin_dsn_encrypted").notNull(),

    /** Max tenant databases this cluster holds before it stops accepting new ones. */
    max_databases: integer("max_databases").notNull().default(2000),

    /** Current number of tenant databases provisioned on this cluster. */
    database_count: integer("database_count").notNull().default(0),

    /** Whether new tenants may be allocated here. */
    is_active: boolean("is_active").notNull().default(true),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    active_idx: index("tenant_db_clusters_active_idx").on(table.is_active),
  }),
);

export type TenantDbCluster = InferSelectModel<typeof tenantDbClusters>;
export type NewTenantDbCluster = InferInsertModel<typeof tenantDbClusters>;
