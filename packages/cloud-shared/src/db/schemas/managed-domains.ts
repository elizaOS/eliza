/**
 * Managed Domains Schema
 *
 * Tracks domains purchased/managed through the platform.
 * Supports assignment to apps, containers, agents, and MCPs.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { containers } from "./containers";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";
import { userMcps } from "./user-mcps";

// Enums
export const domainRegistrarEnum = pgEnum("domain_registrar", ["external", "cloudflare"]);

export const domainNameserverModeEnum = pgEnum("domain_nameserver_mode", [
  "external",
  "cloudflare",
]);

export const domainResourceTypeEnum = pgEnum("domain_resource_type", [
  "app",
  "container",
  "agent",
  "mcp",
]);

export const domainModerationStatusEnum = pgEnum("domain_moderation_status", [
  "clean",
  "pending_review",
  "flagged",
  "suspended",
]);

export const domainStatusEnum = pgEnum("domain_status", [
  "pending",
  "active",
  "expired",
  "suspended",
  "transferring",
]);

// Registrant info structure (for WHOIS)
export interface DomainRegistrantInfo {
  fullName: string;
  email: string;
  organization?: string;
  address: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string; // ISO 3166-1 alpha-2
  };
  phone?: string;
  privacyEnabled?: boolean;
}

// DNS record structure
export interface DnsRecord {
  id?: string;
  type: "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS" | "SRV" | "CAA";
  name: string; // subdomain or @ for apex
  value: string;
  ttl?: number;
  priority?: number; // for MX records
  mxPriority?: number;
  srvWeight?: number;
  srvPort?: number;
  createdAt?: string;
}

// Moderation flag structure
export interface DomainModerationFlag {
  type:
    | "expletive"
    | "trademark"
    | "suspicious"
    | "restricted"
    | "content"
    | "csam"
    | "illegal"
    | "ai_flagged";
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  detectedAt: string;
  resolvedAt?: string;
  aiModel?: string;
  aiConfidence?: number;
}

// AI scan result for caching
export interface ContentScanCache {
  contentHash: string;
  scannedAt: string;
  result: "clean" | "flagged" | "needs_review" | "suspended";
  confidence: number;
  model?: string;
  toxicityScore?: number;
  flags: DomainModerationFlag[];
}

// Suspension notification tracking
export interface SuspensionNotification {
  notifiedAt: string;
  method: "email" | "in_app" | "both";
  reason: string;
  appealEmail: string;
}

export const managedDomains = pgTable(
  "managed_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Domain name (lowercase, normalized)
    domain: text("domain").notNull().unique(),

    // Registration details
    registrar: domainRegistrarEnum("registrar").notNull().default("external"),
    registeredAt: timestamp("registered_at"),
    expiresAt: timestamp("expires_at"),
    autoRenew: boolean("auto_renew").notNull().default(true),
    status: domainStatusEnum("status").notNull().default("pending"),

    // Registrant info (encrypted at rest via DB)
    registrantInfo: jsonb("registrant_info").$type<DomainRegistrantInfo>(),

    // Resource assignment (polymorphic - only one should be set)
    resourceType: domainResourceTypeEnum("resource_type"),
    appId: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),
    containerId: uuid("container_id").references(() => containers.id, {
      onDelete: "set null",
    }),
    agentId: uuid("agent_id").references(() => userCharacters.id, {
      onDelete: "set null",
    }),
    mcpId: uuid("mcp_id").references(() => userMcps.id, {
      onDelete: "set null",
    }),

    // DNS configuration
    nameserverMode: domainNameserverModeEnum("nameserver_mode").notNull().default("external"),
    dnsRecords: jsonb("dns_records").$type<DnsRecord[]>().default([]),
    sslStatus: text("ssl_status")
      .$type<"pending" | "provisioning" | "active" | "error">()
      .default("pending"),
    sslExpiresAt: timestamp("ssl_expires_at"),

    // Verification (for external domains)
    verified: boolean("verified").notNull().default(false),
    verificationToken: text("verification_token"),
    verifiedAt: timestamp("verified_at"),

    // Moderation
    moderationStatus: domainModerationStatusEnum("moderation_status").notNull().default("clean"),
    moderationFlags: jsonb("moderation_flags").$type<DomainModerationFlag[]>().default([]),

    // Health monitoring
    lastHealthCheck: timestamp("last_health_check"),
    isLive: boolean("is_live").notNull().default(false),
    healthCheckError: text("health_check_error"),

    // Content scanning (AI moderation)
    contentHash: text("content_hash"),
    lastContentScanAt: timestamp("last_content_scan_at"),
    lastAiScanAt: timestamp("last_ai_scan_at"),
    aiScanModel: text("ai_scan_model"),
    contentScanConfidence: real("content_scan_confidence"),
    contentScanCache: jsonb("content_scan_cache").$type<ContentScanCache>(),

    // Suspension tracking
    suspendedAt: timestamp("suspended_at"),
    suspensionReason: text("suspension_reason"),
    suspensionNotification: jsonb("suspension_notification").$type<SuspensionNotification>(),
    ownerNotifiedAt: timestamp("owner_notified_at"),

    // Cloudflare registrar identifiers (only set when registrar='cloudflare')
    cloudflareZoneId: text("cloudflare_zone_id"),
    cloudflareRegistrationId: text("cloudflare_registration_id"),

    // Pricing (for purchased domains)
    purchasePrice: text("purchase_price"), // In cents USD
    renewalPrice: text("renewal_price"), // In cents USD
    paymentMethod: text("payment_method"), // 'stripe', 'x402', 'credits'
    stripePaymentIntentId: text("stripe_payment_intent_id"),

    // Timestamps
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("managed_domains_org_idx").on(table.organizationId),
    domainIdx: uniqueIndex("managed_domains_domain_idx").on(table.domain),
    appIdx: index("managed_domains_app_idx").on(table.appId),
    containerIdx: index("managed_domains_container_idx").on(table.containerId),
    agentIdx: index("managed_domains_agent_idx").on(table.agentId),
    mcpIdx: index("managed_domains_mcp_idx").on(table.mcpId),
    statusIdx: index("managed_domains_status_idx").on(table.status),
    moderationIdx: index("managed_domains_moderation_idx").on(table.moderationStatus),
    expiresIdx: index("managed_domains_expires_idx").on(table.expiresAt),
    contentScanIdx: index("managed_domains_content_scan_idx").on(table.lastContentScanAt),
    suspendedIdx: index("managed_domains_suspended_idx").on(table.suspendedAt),
    cloudflareZoneIdx: index("managed_domains_cloudflare_zone_idx").on(table.cloudflareZoneId),
  }),
);

export type ManagedDomain = InferSelectModel<typeof managedDomains>;
export type NewManagedDomain = InferInsertModel<typeof managedDomains>;
