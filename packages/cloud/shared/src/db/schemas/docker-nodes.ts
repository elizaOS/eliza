// Defines the docker nodes Drizzle table shape used by cloud repositories and services.
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentNodeIncarnationHistories } from "./agent-node-incarnation-histories";

export type DockerNodeStatus = "healthy" | "degraded" | "offline" | "unknown";
export type DockerNodeFleetKind = "robot" | "cloud";
export type DockerNodeInfrastructureProvider = "hetzner";

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
    /**
     * Typed backup-source identity. All four fields remain nullable for
     * pre-authority rows; callers must never infer them from metadata,
     * hostname, or the mutable node handle.
     */
    fleet_kind: text("fleet_kind").$type<DockerNodeFleetKind>(),
    infrastructure_provider:
      text("infrastructure_provider").$type<DockerNodeInfrastructureProvider>(),
    provider_server_id: text("provider_server_id"),
    /** Exact lowercase Linux boot UUID attested over host-key-verified SSH. */
    node_incarnation: uuid("node_incarnation"),
    /** Trigger-owned durable token for this exact mutable-node occurrence. */
    current_node_history_id: uuid("current_node_history_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    node_id_idx: index("docker_nodes_node_id_idx").on(table.node_id),
    status_idx: index("docker_nodes_status_idx").on(table.status),
    enabled_idx: index("docker_nodes_enabled_idx").on(table.enabled),
    provider_server_uidx: uniqueIndex("docker_nodes_provider_server_uidx")
      .on(table.infrastructure_provider, table.provider_server_id)
      .where(sql`${table.provider_server_id} IS NOT NULL`),
    node_incarnation_uidx: uniqueIndex("docker_nodes_node_incarnation_uidx")
      .on(table.node_incarnation)
      .where(sql`${table.node_incarnation} IS NOT NULL`),
    current_node_history_fk: foreignKey({
      name: "docker_nodes_current_node_history_fkey",
      columns: [table.current_node_history_id, table.id, table.node_incarnation],
      foreignColumns: [
        agentNodeIncarnationHistories.id,
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
      ],
    }).onDelete("restrict"),
    node_occurrence_shape_check: check(
      "docker_nodes_node_occurrence_shape_check",
      sql`(${table.node_incarnation} IS NULL) = (${table.current_node_history_id} IS NULL)`,
    ),
    backup_source_authority_shape_check: check(
      "docker_nodes_backup_source_authority_shape_check",
      sql`((
        ${table.fleet_kind} IS NULL
        AND ${table.infrastructure_provider} IS NULL
        AND ${table.provider_server_id} IS NULL
        AND ${table.node_incarnation} IS NULL
      ) OR (
        ${table.infrastructure_provider} = 'hetzner'
        AND (${table.node_incarnation} IS NULL OR (
          ${table.host_key_fingerprint} IS NOT NULL
          AND btrim(${table.host_key_fingerprint}) <> ''
        ))
        AND (
          (${table.fleet_kind} = 'robot' AND ${table.provider_server_id} IS NULL)
          OR (
            ${table.fleet_kind} = 'cloud'
            AND ${table.provider_server_id} IS NOT NULL
            AND CASE
              WHEN ${table.provider_server_id} ~ '^[1-9][0-9]{0,19}$'
                THEN ${table.provider_server_id}::numeric <= 18446744073709551615
              ELSE false
            END
          )
        )
      )) IS TRUE`,
    ),
  }),
);

export type DockerNode = InferSelectModel<typeof dockerNodes>;
export type NewDockerNode = InferInsertModel<typeof dockerNodes>;
