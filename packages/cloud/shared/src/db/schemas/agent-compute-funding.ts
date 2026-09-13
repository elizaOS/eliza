/** Binds Dedicated compute intervals to reserved funds and exact provider instances. */

import { type InferSelectModel, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";
import { billingFundingReservations } from "./billing-funding-reservations";

export const agentComputeFunding = pgTable(
  "agent_compute_funding",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    agent_id: uuid("agent_id").notNull(),
    funding_reservation_id: uuid("funding_reservation_id").notNull(),
    period_start: timestamp("period_start", { withTimezone: true }).notNull(),
    period_end: timestamp("period_end", { withTimezone: true }).notNull(),
    hourly_rate: numeric("hourly_rate", { precision: 16, scale: 6 }).notNull(),
    provider_node_id: text("provider_node_id"),
    provider_container_id: text("provider_container_id"),
    provider_bound_at: timestamp("provider_bound_at", { withTimezone: true }),
    settled_through: timestamp("settled_through", { withTimezone: true }),
    settled_at: timestamp("settled_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agent_tenant_fk: foreignKey({
      columns: [table.agent_id, table.organization_id],
      foreignColumns: [agentSandboxes.id, agentSandboxes.organization_id],
      name: "agent_compute_funding_agent_tenant_fk",
    }).onDelete("restrict"),
    reservation_tenant_fk: foreignKey({
      columns: [table.funding_reservation_id, table.organization_id],
      foreignColumns: [billingFundingReservations.id, billingFundingReservations.organization_id],
      name: "agent_compute_funding_reservation_tenant_fk",
    }).onDelete("restrict"),
    reservation_unique: uniqueIndex("agent_compute_funding_reservation_idx").on(
      table.funding_reservation_id,
    ),
    open_agent_unique: uniqueIndex("agent_compute_funding_open_agent_idx")
      .on(table.agent_id)
      .where(sql`${table.settled_at} IS NULL`),
    expiry_idx: index("agent_compute_funding_expiry_idx")
      .on(table.period_end)
      .where(sql`${table.settled_at} IS NULL`),
    period_check: check(
      "agent_compute_funding_period_check",
      sql`${table.period_end} > ${table.period_start} AND ${table.hourly_rate} > 0
        AND ${table.hourly_rate} <> 'NaN'::numeric`,
    ),
    provider_check: check(
      "agent_compute_funding_provider_check",
      sql`num_nonnulls(${table.provider_node_id}, ${table.provider_container_id}, ${table.provider_bound_at}) IN (0, 3)
        AND (${table.provider_container_id} IS NULL OR ${table.provider_container_id} ~ '^[0-9a-f]{64}$')
        AND (${table.provider_node_id} IS NULL OR length(${table.provider_node_id}) > 0)`,
    ),
    settlement_check: check(
      "agent_compute_funding_settlement_check",
      sql`(${table.settled_at} IS NULL AND ${table.settled_through} IS NULL)
        OR (${table.settled_at} IS NOT NULL AND ${table.settled_through} IS NOT NULL
          AND ${table.settled_through} BETWEEN ${table.period_start} AND ${table.period_end})`,
    ),
  }),
);

export type AgentComputeFunding = InferSelectModel<typeof agentComputeFunding>;
