import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type DockerNodeStatus = "healthy" | "degraded" | "offline" | "unknown";

export const dockerNodes = pgTable(
  "docker_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    node_id: text("node_id").unique().notNull(),
    hostname: text("hostname").notNull(),
    ssh_port: integer("ssh_port").notNull().default(22),
    capacity: integer("capacity").notNull().default(8),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status").$type<DockerNodeStatus>().notNull().default("unknown"),
    allocated_count: integer("allocated_count").notNull().default(0),
    last_health_check: timestamp("last_health_check", { withTimezone: true }),
    ssh_user: text("ssh_user").notNull().default("root"),
    host_key_fingerprint: text("host_key_fingerprint"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    node_id_idx: index("docker_nodes_node_id_idx").on(table.node_id),
    status_idx: index("docker_nodes_status_idx").on(table.status),
    enabled_idx: index("docker_nodes_enabled_idx").on(table.enabled),
  }),
);

export type DockerNode = InferSelectModel<typeof dockerNodes>;
export type NewDockerNode = InferInsertModel<typeof dockerNodes>;
