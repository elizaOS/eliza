/** Durable, provider-neutral receipts for explicit billable-resource stops. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { organizations } from "./organizations";
import { users } from "./users";

export const BILLING_CANCEL_RESOURCE_TYPES = ["container", "agent_sandbox"] as const;
export type BillingCancelResourceType = (typeof BILLING_CANCEL_RESOURCE_TYPES)[number];

export const billingCancelCommands = pgTable(
  "billing_cancel_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    requested_by_user_id: uuid("requested_by_user_id").notNull(),
    resource_type: text("resource_type").$type<BillingCancelResourceType>().notNull(),
    resource_id: uuid("resource_id").notNull(),
    expected_lifecycle_revision: bigint("expected_lifecycle_revision", {
      mode: "number",
    }).notNull(),
    action: text("action").$type<"stop">().notNull().default("stop"),
    job_id: uuid("job_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenant_identity_unique: unique("billing_cancel_commands_id_org_unique").on(
      table.id,
      table.organization_id,
    ),
    requesting_user_tenant_fk: foreignKey({
      name: "billing_cancel_commands_requesting_user_tenant_fkey",
      columns: [table.requested_by_user_id, table.organization_id],
      foreignColumns: [users.id, users.organization_id],
    }).onDelete("restrict"),
    job_tenant_fk: foreignKey({
      name: "billing_cancel_commands_job_tenant_fkey",
      columns: [table.job_id, table.organization_id],
      foreignColumns: [jobs.id, jobs.organization_id],
    }).onDelete("restrict"),
    job_unique: unique("billing_cancel_commands_job_unique").on(table.job_id),
    logical_command_unique: uniqueIndex("billing_cancel_commands_logical_unique").on(
      table.organization_id,
      table.resource_type,
      table.resource_id,
      table.expected_lifecycle_revision,
      table.action,
    ),
    organization_created_idx: index("billing_cancel_commands_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    shape_check: check(
      "billing_cancel_commands_shape_check",
      sql`${table.resource_type} IN ('container', 'agent_sandbox')
        AND ${table.action} = 'stop'
        AND ${table.expected_lifecycle_revision} >= 0`,
    ),
  }),
);

/**
 * Every client key is retained as an alias. Distinct tabs may therefore share
 * one command/job without making either key reusable for a different request.
 */
export const billingCancelCommandKeys = pgTable(
  "billing_cancel_command_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_digest: text("request_digest").notNull(),
    command_id: uuid("command_id").notNull(),
    requested_by_user_id: uuid("requested_by_user_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organization_key_unique: unique("billing_cancel_command_keys_org_key_unique").on(
      table.organization_id,
      table.idempotency_key_hash,
    ),
    command_tenant_fk: foreignKey({
      name: "billing_cancel_command_keys_command_tenant_fkey",
      columns: [table.command_id, table.organization_id],
      foreignColumns: [billingCancelCommands.id, billingCancelCommands.organization_id],
    }).onDelete("restrict"),
    requesting_user_tenant_fk: foreignKey({
      name: "billing_cancel_command_keys_requesting_user_tenant_fkey",
      columns: [table.requested_by_user_id, table.organization_id],
      foreignColumns: [users.id, users.organization_id],
    }).onDelete("restrict"),
    command_idx: index("billing_cancel_command_keys_command_idx").on(table.command_id),
    digest_shape_check: check(
      "billing_cancel_command_keys_digest_shape_check",
      sql`${table.idempotency_key_hash} ~ '^[a-f0-9]{64}$'
        AND ${table.request_digest} ~ '^[a-f0-9]{64}$'`,
    ),
  }),
);

export type BillingCancelCommand = InferSelectModel<typeof billingCancelCommands>;
export type NewBillingCancelCommand = InferInsertModel<typeof billingCancelCommands>;
export type BillingCancelCommandKey = InferSelectModel<typeof billingCancelCommandKeys>;
export type NewBillingCancelCommandKey = InferInsertModel<typeof billingCancelCommandKeys>;
