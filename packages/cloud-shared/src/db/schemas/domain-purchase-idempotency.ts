import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";
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
    charge_id: uuid("charge_id"),
    charge: jsonb("charge").$type<Record<string, unknown>>(),
    cloudflare_registration_id: text("cloudflare_registration_id"),
    managed_domain_id: uuid("managed_domain_id"),
    response_body: jsonb("response_body").$type<Record<string, unknown>>(),
    error_code: text("error_code"),
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
  }),
);

export type DomainPurchaseIdempotency = InferSelectModel<typeof domainPurchaseIdempotency>;
export type NewDomainPurchaseIdempotency = InferInsertModel<typeof domainPurchaseIdempotency>;
