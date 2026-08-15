// Defines the docker nodes Drizzle table shape used by cloud repositories and services.
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

/**
 * Whether a node may receive NEW placements, independent of whether it is
 * operationally enabled.
 *
 * `enabled=false` was the only switch, and it is too blunt to cordon with: it
 * also removes the node from health checks, allocated-count sync, disk
 * monitoring, and the orphan reconciler — exactly the loops that must keep
 * running while its residents are still serving traffic and being moved off.
 *
 * - `open`       — normal, accepts new placements.
 * - `cordoned`   — no new placements; residents keep running, untouched.
 * - `evacuating` — cordoned, and residents are actively being moved off.
 * - `drained`    — cordoned and empty; eligible for decommission or repurposing.
 */
export type NodePlacementState = "open" | "cordoned" | "evacuating" | "drained";

/** The one state in which a node may take new work. */
export const PLACEABLE_NODE_STATE: NodePlacementState = "open";

export const dockerNodes = pgTable(
  "docker_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    node_id: text("node_id").unique().notNull(),
    hostname: text("hostname").notNull(),
    ssh_port: integer("ssh_port").notNull().default(22),
    capacity: integer("capacity").notNull().default(8),
    enabled: boolean("enabled").notNull().default(true),
    placement_state: text("placement_state").$type<NodePlacementState>().notNull().default("open"),
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
