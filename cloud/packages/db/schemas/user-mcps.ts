import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { containers } from "./containers";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * MCP pricing type enum
 */
export const mcpPricingTypeEnum = pgEnum("mcp_pricing_type", ["free", "credits", "x402"]);

/**
 * MCP status enum
 */
export const mcpStatusEnum = pgEnum("mcp_status", [
  "draft",
  "pending_review",
  "live",
  "suspended",
  "deprecated",
]);

/**
 * User MCPs table schema.
 *
 * Represents user-created MCP servers that can be monetized.
 * Users can deploy MCPs to containers or point to external endpoints.
 */
export const userMcps = pgTable(
  "user_mcps",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // MCP identification
    name: text("name").notNull(),
    slug: text("slug").notNull(), // URL-friendly identifier
    description: text("description").notNull(),
    version: text("version").notNull().default("1.0.0"),

    // Owner
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Endpoint configuration
    endpoint_type: text("endpoint_type").notNull().default("container"), // 'container' | 'external'
    container_id: uuid("container_id").references(() => containers.id, {
      onDelete: "set null",
    }),
    external_endpoint: text("external_endpoint"), // For external MCPs
    endpoint_path: text("endpoint_path").default("/mcp"), // Path on the container/endpoint

    // MCP Protocol details
    transport_type: text("transport_type").notNull().default("streamable-http"), // 'http' | 'sse' | 'streamable-http'
    mcp_version: text("mcp_version").default("2025-06-18"),

    // Tools definition (extracted from MCP or manually configured)
    tools: jsonb("tools")
      .$type<
        Array<{
          name: string;
          description: string;
          inputSchema?: Record<string, unknown>;
          cost?: string; // e.g., "1 credit" or "$0.001"
        }>
      >()
      .notNull()
      .default([]),

    // Category and discovery
    category: text("category").notNull().default("utilities"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    icon: text("icon").default("puzzle"),
    color: text("color").default("#6366F1"),

    // Pricing configuration
    pricing_type: mcpPricingTypeEnum("pricing_type").notNull().default("credits"),
    credits_per_request: numeric("credits_per_request", {
      precision: 10,
      scale: 4,
    }).default("1.0000"),
    x402_price_usd: numeric("x402_price_usd", {
      precision: 10,
      scale: 6,
    }).default("0.000100"), // $0.0001 default
    x402_enabled: boolean("x402_enabled").default(false).notNull(),

    // Revenue share configuration
    creator_share_percentage: numeric("creator_share_percentage", {
      precision: 5,
      scale: 2,
    })
      .default("80.00")
      .notNull(), // Creator gets 80% by default
    platform_share_percentage: numeric("platform_share_percentage", {
      precision: 5,
      scale: 2,
    })
      .default("20.00")
      .notNull(), // Platform gets 20%

    // Usage statistics
    total_requests: integer("total_requests").default(0).notNull(),
    total_credits_earned: numeric("total_credits_earned", {
      precision: 12,
      scale: 4,
    }).default("0.0000"),
    total_x402_earned_usd: numeric("total_x402_earned_usd", {
      precision: 12,
      scale: 6,
    }).default("0.000000"),
    unique_users: integer("unique_users").default(0).notNull(),

    // Status
    status: mcpStatusEnum("status").notNull().default("draft"),
    is_public: boolean("is_public").default(true).notNull(),
    is_featured: boolean("is_featured").default(false).notNull(),

    // Verification and trust
    is_verified: boolean("is_verified").default(false).notNull(),
    verified_at: timestamp("verified_at"),
    verified_by: uuid("verified_by").references(() => users.id),

    // Documentation
    documentation_url: text("documentation_url"),
    source_code_url: text("source_code_url"),
    support_email: text("support_email"),

    // Metadata
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),

    // =========================================================================
    // ERC-8004 On-Chain Registration
    // When MCPs are published, they can be registered on the ERC-8004 Identity
    // Registry, making them discoverable by other agents across the ecosystem.
    // =========================================================================
    erc8004_registered: boolean("erc8004_registered").default(false).notNull(),
    erc8004_network: text("erc8004_network"), // e.g., "base-sepolia", "base"
    erc8004_agent_id: integer("erc8004_agent_id"), // Token ID on the registry
    erc8004_agent_uri: text("erc8004_agent_uri"), // IPFS or HTTP URI
    erc8004_tx_hash: text("erc8004_tx_hash"), // Registration transaction
    erc8004_registered_at: timestamp("erc8004_registered_at"),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    last_used_at: timestamp("last_used_at"),
    published_at: timestamp("published_at"),
  },
  (table) => ({
    slug_org_idx: uniqueIndex("user_mcps_slug_org_idx").on(table.slug, table.organization_id),
    organization_idx: index("user_mcps_organization_idx").on(table.organization_id),
    created_by_idx: index("user_mcps_created_by_idx").on(table.created_by_user_id),
    container_idx: index("user_mcps_container_idx").on(table.container_id),
    category_idx: index("user_mcps_category_idx").on(table.category),
    status_idx: index("user_mcps_status_idx").on(table.status),
    is_public_idx: index("user_mcps_is_public_idx").on(table.is_public),
    created_at_idx: index("user_mcps_created_at_idx").on(table.created_at),
    erc8004_registered_idx: index("user_mcps_erc8004_registered_idx").on(table.erc8004_registered),
  }),
);

/**
 * MCP usage tracking table.
 *
 * Tracks individual usage of MCPs by organizations/users.
 */
export const mcpUsage = pgTable(
  "mcp_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    mcp_id: uuid("mcp_id")
      .notNull()
      .references(() => userMcps.id, { onDelete: "cascade" }),

    // Who used it
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Usage details
    tool_name: text("tool_name").notNull(),
    request_count: integer("request_count").default(1).notNull(),

    // Billing
    credits_charged: numeric("credits_charged", {
      precision: 10,
      scale: 4,
    }).default("0.0000"),
    x402_amount_usd: numeric("x402_amount_usd", {
      precision: 10,
      scale: 6,
    }).default("0.000000"),
    payment_type: text("payment_type").notNull().default("credits"), // 'credits' | 'x402'

    // Revenue distribution
    creator_earnings: numeric("creator_earnings", {
      precision: 10,
      scale: 4,
    }).default("0.0000"),
    platform_earnings: numeric("platform_earnings", {
      precision: 10,
      scale: 4,
    }).default("0.0000"),

    // Metadata
    metadata: jsonb("metadata")
      .$type<{
        input?: Record<string, unknown>;
        responseTime?: number;
        success?: boolean;
        error?: string;
      }>()
      .default({})
      .notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    mcp_id_idx: index("mcp_usage_mcp_id_idx").on(table.mcp_id),
    organization_idx: index("mcp_usage_organization_idx").on(table.organization_id),
    user_idx: index("mcp_usage_user_idx").on(table.user_id),
    created_at_idx: index("mcp_usage_created_at_idx").on(table.created_at),
    mcp_org_idx: index("mcp_usage_mcp_org_idx").on(table.mcp_id, table.organization_id),
  }),
);

// Type inference
export type UserMcp = InferSelectModel<typeof userMcps>;
export type NewUserMcp = InferInsertModel<typeof userMcps>;
export type McpUsage = InferSelectModel<typeof mcpUsage>;
export type NewMcpUsage = InferInsertModel<typeof mcpUsage>;
