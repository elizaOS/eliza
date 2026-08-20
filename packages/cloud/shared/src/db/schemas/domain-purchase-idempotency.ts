// Defines the domain purchase idempotency Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { creditTransactions } from "./credit-transactions";
import { managedDomains } from "./managed-domains";
import { organizations } from "./organizations";

/**
 * Idempotency ledger for domain purchases. A row is claimed (unique `key`)
 * BEFORE any credits are debited or Cloudflare is called, so a retried or
 * concurrent buy of the same domain cannot double-charge or double-register —
 * the loser short-circuits on the completed row's cached `response_body`.
 * Mirrors `app_image_generation_idempotency`.
 */
export const domainPurchaseIdempotency = pgTable(
  "domain_purchase_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status").notNull().default("processing"),
    request_digest: text("request_digest"),
    registration_years: integer("registration_years"),
    charge_id: uuid("charge_id").references(() => creditTransactions.id, {
      onDelete: "restrict",
    }),
    refund_id: uuid("refund_id").references(() => creditTransactions.id, {
      onDelete: "restrict",
    }),
    charge: jsonb("charge").$type<Record<string, unknown>>(),
    cloudflare_registration_id: text("cloudflare_registration_id"),
    managed_domain_id: uuid("managed_domain_id").references(() => managedDomains.id, {
      onDelete: "restrict",
    }),
    response_body: jsonb("response_body").$type<Record<string, unknown>>(),
    response_status: integer("response_status"),
    error_code: text("error_code"),
    lease_token: uuid("lease_token"),
    provider_started_at: timestamp("provider_started_at"),
    next_reconcile_at: timestamp("next_reconcile_at"),
    attempt_count: integer("attempt_count").notNull().default(0),
    expires_at: timestamp("expires_at").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    key_unique: uniqueIndex("domain_purchase_idempotency_key_idx").on(table.key),
    org_domain_idx: index("domain_purchase_idempotency_org_domain_idx").on(
      table.organization_id,
      table.domain,
    ),
    expires_idx: index("domain_purchase_idempotency_expires_idx").on(table.expires_at),
    status_idx: index("domain_purchase_idempotency_status_idx").on(table.status),
    reconcile_idx: index("domain_purchase_idempotency_reconcile_idx").on(
      table.status,
      table.next_reconcile_at,
    ),
  }),
);

export type DomainPurchaseIdempotency = InferSelectModel<typeof domainPurchaseIdempotency>;
export type NewDomainPurchaseIdempotency = InferInsertModel<typeof domainPurchaseIdempotency>;
