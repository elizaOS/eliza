/** Append-only Docker-node occurrence authorities. */

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * One immutable attestation occurrence for a Docker-node record.
 *
 * `node_incarnation` may recur on the same record after NULL/rearm, ABA, or a
 * delete/reinsert. The row `id`, not the mutable incarnation UUID, is the
 * durable occurrence token used by current nodes and restore operations.
 */
export const agentNodeIncarnationHistories = pgTable(
  "agent_node_incarnation_histories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    docker_node_record_id: uuid("docker_node_record_id").notNull(),
    node_id: text("node_id").notNull(),
    node_incarnation: uuid("node_incarnation").notNull(),
    fleet_kind: text("fleet_kind").notNull(),
    infrastructure_provider: text("infrastructure_provider").notNull(),
    provider_server_id: text("provider_server_id"),
    host_key_fingerprint: text("host_key_fingerprint").notNull(),
    attested_at: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    record_incarnation_idx: index("agent_node_incarnation_histories_record_incarnation_idx").on(
      table.docker_node_record_id,
      table.node_incarnation,
    ),
    receipt_authority_unique: unique(
      "agent_node_incarnation_histories_receipt_authority_unique",
    ).on(table.id, table.docker_node_record_id, table.node_incarnation),
    shape_check: check(
      "agent_node_incarnation_histories_shape_check",
      sql`(${table.node_id} = btrim(${table.node_id})
        AND octet_length(${table.node_id}) BETWEEN 1 AND 255
        AND ${table.fleet_kind} IN ('robot', 'cloud')
        AND ${table.infrastructure_provider} = 'hetzner'
        AND btrim(${table.host_key_fingerprint}) <> ''
        AND ((${table.fleet_kind} = 'robot' AND ${table.provider_server_id} IS NULL)
          OR (${table.fleet_kind} = 'cloud'
            AND ${table.provider_server_id} ~ '^[1-9][0-9]{0,19}$'))) IS TRUE`,
    ),
  }),
);

export type AgentNodeIncarnationHistory = InferSelectModel<typeof agentNodeIncarnationHistories>;
