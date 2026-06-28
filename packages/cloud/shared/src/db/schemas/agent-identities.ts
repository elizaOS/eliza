import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";
import { organizations } from "./organizations";

export const agentIdentities = pgTable(
  "agent_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sandbox_agent_id: uuid("sandbox_agent_id")
      .notNull()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    standard: text("standard").notNull().default("erc-8004"),
    chain_id: integer("chain_id").notNull(),
    registry_address: text("registry_address").notNull(),
    token_id: text("token_id").notNull(),
    agent_uri: text("agent_uri").notNull(),
    uri_ipfs: text("uri_ipfs"),
    owner_wallet_address: text("owner_wallet_address").notNull(),
    tx_hash: text("tx_hash").notNull(),
    block_number: text("block_number"),
    status: text("status").notNull().default("confirmed"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sandbox_idx: index("agent_identities_sandbox_idx").on(table.sandbox_agent_id),
    organization_idx: index("agent_identities_organization_idx").on(table.organization_id),
    token_unique: uniqueIndex("agent_identities_chain_registry_token_unique").on(
      table.chain_id,
      table.registry_address,
      table.token_id,
    ),
    sandbox_standard_unique: uniqueIndex("agent_identities_sandbox_standard_chain_unique").on(
      table.sandbox_agent_id,
      table.standard,
      table.chain_id,
    ),
  }),
);

export type AgentIdentity = InferSelectModel<typeof agentIdentities>;
export type NewAgentIdentity = InferInsertModel<typeof agentIdentities>;
