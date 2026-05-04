import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";
import { users } from "./users";

/**
 * Agent Server Wallets table schema.
 *
 * Tracks secure server-side wallets provisioned for agents.
 * Supports dual providers: Privy (legacy) and Steward (new).
 *
 * The `wallet_provider` column routes RPC calls to the correct backend.
 * New wallets default to 'steward' when the feature flag is enabled;
 * existing wallets remain on 'privy' until explicitly migrated.
 */
export const agentServerWallets = pgTable(
  "agent_server_wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    character_id: uuid("character_id").references(() => userCharacters.id, {
      onDelete: "set null",
    }),

    // Provider routing: 'privy' (legacy) or 'steward' (new)
    wallet_provider: text("wallet_provider").notNull().default("privy"),

    // Privy wallet ID (nullable — only set for privy-managed wallets)
    privy_wallet_id: text("privy_wallet_id"),

    // Steward references (only set for steward-managed wallets)
    steward_agent_id: text("steward_agent_id"),
    steward_tenant_id: text("steward_tenant_id"),

    // The public address of the provisioned wallet
    address: text("address").notNull(),

    // Target blockchain ecosystem (e.g. "evm", "solana")
    chain_type: text("chain_type").notNull(),

    // The EVM address of the local agent used to authenticate RPC calls.
    client_address: text("client_address").notNull().unique(),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("agent_server_wallets_organization_idx").on(table.organization_id),
    user_idx: index("agent_server_wallets_user_idx").on(table.user_id),
    character_idx: index("agent_server_wallets_character_idx").on(table.character_id),
    privy_wallet_idx: index("agent_server_wallets_privy_wallet_idx").on(table.privy_wallet_id),
    address_idx: index("agent_server_wallets_address_idx").on(table.address),
    client_address_idx: index("agent_server_wallets_client_address_idx").on(table.client_address),
    steward_agent_idx: index("agent_server_wallets_steward_agent_idx").on(table.steward_agent_id),
    wallet_provider_idx: index("agent_server_wallets_wallet_provider_idx").on(
      table.wallet_provider,
    ),
  }),
);

export type AgentServerWallet = InferSelectModel<typeof agentServerWallets>;
export type NewAgentServerWallet = InferInsertModel<typeof agentServerWallets>;
