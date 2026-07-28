/**
 * Atomic ownership of every Docker host port shared by managed agents,
 * restore-validation candidates, and app containers. The node/port primary key
 * is the single collision authority; owner and port-kind checks keep retries
 * idempotent and prevent a caller from reserving outside its structural range.
 */

import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type DockerHostPortOwnerKind = "agent" | "restore_validation" | "app";
export type DockerHostPortKind =
  | "agent_bridge"
  | "agent_web"
  | "restore_bridge"
  | "restore_web"
  | "app";

export const dockerHostPortReservations = pgTable(
  "docker_host_port_reservations",
  {
    node_id: text("node_id").notNull(),
    host_port: integer("host_port").notNull(),
    owner_kind: text("owner_kind").$type<DockerHostPortOwnerKind>().notNull(),
    owner_id: text("owner_id").notNull(),
    port_kind: text("port_kind").$type<DockerHostPortKind>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primary: primaryKey({
      name: "docker_host_port_reservations_pkey",
      columns: [table.node_id, table.host_port],
    }),
    owner_port_kind_unique: uniqueIndex("docker_host_port_reservations_owner_kind_unique").on(
      table.node_id,
      table.owner_kind,
      table.owner_id,
      table.port_kind,
    ),
    contract_check: check(
      "docker_host_port_reservations_contract_check",
      sql`
        length(${table.node_id}) > 0
        AND length(${table.owner_id}) > 0
        AND (
          (
            ${table.owner_kind} = 'agent'
            AND (
              (
                ${table.port_kind} = 'agent_bridge'
                AND ${table.host_port} >= 18790
                AND ${table.host_port} < 19790
              )
              OR (
                ${table.port_kind} = 'agent_web'
                AND ${table.host_port} >= 20000
                AND ${table.host_port} < 25000
              )
            )
          )
          OR (
            ${table.owner_kind} = 'restore_validation'
            AND (
              (
                ${table.port_kind} = 'restore_bridge'
                AND ${table.host_port} >= 18790
                AND ${table.host_port} < 19790
              )
              OR (
                ${table.port_kind} = 'restore_web'
                AND ${table.host_port} >= 20000
                AND ${table.host_port} < 25000
              )
            )
          )
          OR (
            ${table.owner_kind} = 'app'
            AND ${table.port_kind} = 'app'
            AND ${table.host_port} >= 20000
            AND ${table.host_port} < 40000
          )
        )
      `,
    ),
  }),
);
