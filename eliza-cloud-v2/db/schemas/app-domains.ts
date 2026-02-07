/**
 * App Domains Schema
 *
 * Manages subdomains and custom domains for apps.
 * Integrates with Vercel for DNS and SSL.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

export interface DomainVerificationRecord {
  type: "TXT" | "CNAME" | "A";
  name: string;
  value: string;
}

export const appDomains = pgTable(
  "app_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    // Subdomain (under *.apps.elizacloud.ai)
    subdomain: text("subdomain").notNull(),

    // Custom domain (optional)
    custom_domain: text("custom_domain"),
    custom_domain_verified: boolean("custom_domain_verified")
      .default(false)
      .notNull(),
    verification_records: jsonb("verification_records")
      .$type<DomainVerificationRecord[]>()
      .default([]),

    // SSL/TLS
    ssl_status: text("ssl_status")
      .$type<"pending" | "provisioning" | "active" | "error">()
      .default("pending")
      .notNull(),
    ssl_error: text("ssl_error"),

    // Vercel project binding (for custom domains)
    vercel_project_id: text("vercel_project_id"),
    vercel_domain_id: text("vercel_domain_id"),

    // Primary flag
    is_primary: boolean("is_primary").default(true).notNull(),

    // Timestamps
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    verified_at: timestamp("verified_at"),
  },
  (table) => ({
    app_id_idx: index("app_domains_app_id_idx").on(table.app_id),
    subdomain_idx: uniqueIndex("app_domains_subdomain_idx").on(table.subdomain),
    custom_domain_idx: uniqueIndex("app_domains_custom_domain_idx").on(
      table.custom_domain,
    ),
    vercel_domain_idx: index("app_domains_vercel_domain_idx").on(
      table.vercel_domain_id,
    ),
  }),
);

export type AppDomain = InferSelectModel<typeof appDomains>;
export type NewAppDomain = InferInsertModel<typeof appDomains>;
