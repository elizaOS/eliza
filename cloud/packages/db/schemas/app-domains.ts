/**
 * App Domains Schema
 *
 * Manages subdomains and custom domains for apps.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";

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
    custom_domain_verified: boolean("custom_domain_verified").default(false).notNull(),
    verification_records: jsonb("verification_records")
      .$type<DomainVerificationRecord[]>()
      .default([]),

    // SSL/TLS
    ssl_status: text("ssl_status")
      .$type<"pending" | "provisioning" | "active" | "error">()
      .default("pending")
      .notNull(),
    ssl_error: text("ssl_error"),

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
    custom_domain_idx: uniqueIndex("app_domains_custom_domain_idx").on(table.custom_domain),
  }),
);

export type AppDomain = InferSelectModel<typeof appDomains>;
export type NewAppDomain = InferInsertModel<typeof appDomains>;
