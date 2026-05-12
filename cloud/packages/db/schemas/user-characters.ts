import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * User characters table schema.
 *
 * Stores character definitions created by users. Characters can be templates,
 * public marketplace items, or private user characters.
 *
 * When is_public=true, the character can be:
 * - Registered on ERC-8004 for discovery (erc8004_registered=true)
 * - Monetized with inference markup (monetization_enabled=true)
 * - Accessible via A2A and MCP protocols
 */
export const userCharacters = pgTable(
  "user_characters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Unique username for URL routing (/chat/@username) and display
    // Validation: 3-30 chars, alphanumeric + hyphens, no consecutive/leading/trailing hyphens
    username: text("username").unique(),
    system: text("system"),
    bio: jsonb("bio").$type<string | string[]>().notNull(),
    message_examples: jsonb("message_examples").$type<Record<string, unknown>[][]>().default([]),
    post_examples: jsonb("post_examples").$type<string[]>().default([]),
    topics: jsonb("topics").$type<string[]>().default([]),
    adjectives: jsonb("adjectives").$type<string[]>().default([]),
    knowledge: jsonb("knowledge")
      .$type<(string | { path: string; shared?: boolean })[]>()
      .default([]),
    plugins: jsonb("plugins").$type<string[]>().default([]),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    secrets: jsonb("secrets").$type<Record<string, string | boolean | number>>().default({}),
    style: jsonb("style")
      .$type<{
        all?: string[];
        chat?: string[];
        post?: string[];
      }>()
      .default({}),
    character_data: jsonb("character_data").$type<Record<string, unknown>>().notNull(),
    is_template: boolean("is_template").default(false).notNull(),
    is_public: boolean("is_public").default(false).notNull(),
    avatar_url: text("avatar_url"),
    category: text("category"),
    tags: jsonb("tags").$type<string[]>().default([]),
    featured: boolean("featured").default(false).notNull(),
    view_count: integer("view_count").default(0).notNull(),
    interaction_count: integer("interaction_count").default(0).notNull(),
    popularity_score: integer("popularity_score").default(0).notNull(),
    // Source tracking: where the character was created
    // "cloud" = created in Eliza Cloud
    source: text("source").default("cloud").notNull(),

    // =========================================================================
    // Token Linkage
    // Associates an agent with a specific on-chain token.
    // First-class columns so thin clients can query/filter without JSONB hacks.
    // =========================================================================
    /** On-chain token contract/mint address (e.g. Solana mint or EVM contract). */
    token_address: text("token_address"),
    /** Chain identifier (e.g. "solana", "base", "ethereum"). */
    token_chain: text("token_chain"),
    /** Human-readable token name (e.g. "MyToken"). */
    token_name: text("token_name"),
    /** Token ticker symbol (e.g. "MTK"). */
    token_ticker: text("token_ticker"),

    // =========================================================================
    // ERC-8004 On-Chain Registration
    // When public agents are registered, they become discoverable by other agents
    // =========================================================================
    erc8004_registered: boolean("erc8004_registered").default(false).notNull(),
    erc8004_network: text("erc8004_network"), // e.g., "base-sepolia", "base"
    erc8004_agent_id: integer("erc8004_agent_id"), // Token ID on the registry
    erc8004_agent_uri: text("erc8004_agent_uri"), // IPFS or HTTP URI
    erc8004_tx_hash: text("erc8004_tx_hash"), // Registration transaction
    erc8004_registered_at: timestamp("erc8004_registered_at"),

    // =========================================================================
    // Monetization Settings (similar to apps)
    // Creators can add markup on top of base inference costs
    // =========================================================================
    monetization_enabled: boolean("monetization_enabled").default(false).notNull(),
    // Percentage markup on inference costs (0-1000%)
    // e.g., 50% markup means user pays 1.5x base cost, creator gets 0.5x
    inference_markup_percentage: numeric("inference_markup_percentage", {
      precision: 7,
      scale: 2,
    })
      .default("0.00")
      .notNull(),
    // Wallet to receive earnings (uses org wallet if not set)
    payout_wallet_address: text("payout_wallet_address"),

    // Earnings tracking
    total_inference_requests: integer("total_inference_requests").default(0).notNull(),
    total_creator_earnings: numeric("total_creator_earnings", {
      precision: 12,
      scale: 4,
    })
      .default("0.0000")
      .notNull(),
    total_platform_revenue: numeric("total_platform_revenue", {
      precision: 12,
      scale: 4,
    })
      .default("0.0000")
      .notNull(),

    // =========================================================================
    // Protocol Endpoints (generated when public)
    // Each public agent gets its own A2A and MCP endpoints
    // =========================================================================
    // A2A endpoint: /api/agents/{id}/a2a
    // MCP endpoint: /api/agents/{id}/mcp
    a2a_enabled: boolean("a2a_enabled").default(true).notNull(),
    mcp_enabled: boolean("mcp_enabled").default(true).notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("user_characters_organization_idx").on(table.organization_id),
    user_idx: index("user_characters_user_idx").on(table.user_id),
    name_idx: index("user_characters_name_idx").on(table.name),
    username_idx: index("user_characters_username_idx").on(table.username),
    category_idx: index("user_characters_category_idx").on(table.category),
    featured_idx: index("user_characters_featured_idx").on(table.featured),
    template_idx: index("user_characters_is_template_idx").on(table.is_template),
    public_idx: index("user_characters_is_public_idx").on(table.is_public),
    popularity_idx: index("user_characters_popularity_idx").on(table.popularity_score),
    source_idx: index("user_characters_source_idx").on(table.source),
    // New indexes for ERC-8004 and monetization
    erc8004_idx: index("user_characters_erc8004_idx").on(table.erc8004_registered),
    erc8004_agent_idx: index("user_characters_erc8004_agent_idx").on(
      table.erc8004_network,
      table.erc8004_agent_id,
    ),
    monetization_idx: index("user_characters_monetization_idx").on(table.monetization_enabled),
    // Keep this plain Drizzle index in sync with db/migrations/0047_add_token_agent_linkage.sql.
    // The partial unique (token_address, token_chain) index is hand-managed in SQL because
    // Drizzle schema generation cannot represent the WHERE token_address IS NOT NULL predicate.
    token_address_idx: index("user_characters_token_address_idx").on(table.token_address),
  }),
);

// Type inference
export type UserCharacter = InferSelectModel<typeof userCharacters>;
export type NewUserCharacter = InferInsertModel<typeof userCharacters>;
