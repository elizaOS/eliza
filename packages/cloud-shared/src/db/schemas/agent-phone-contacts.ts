import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Shared gateway contact routing.
 *
 * A row means an agent has contacted a phone/iMessage identity through the
 * shared gateway. If that identity later texts the gateway number and does not
 * have a higher-priority agent of their own, route the inbound message back to
 * this agent.
 */
export const agentPhoneContacts = pgTable(
  "agent_phone_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    contact_identifier: text("contact_identifier").notNull(),
    contact_display_name: text("contact_display_name"),
    first_contacted_at: timestamp("first_contacted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_contacted_at: timestamp("last_contacted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_inbound_at: timestamp("last_inbound_at", { withTimezone: true }),
    last_outbound_at: timestamp("last_outbound_at", { withTimezone: true }),
    is_active: boolean("is_active").notNull().default(true),
    metadata: text("metadata").notNull().default("{}"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unique_agent_contact: uniqueIndex("agent_phone_contacts_agent_contact_idx").on(
      table.provider,
      table.contact_identifier,
      table.agent_id,
    ),
    contact_lookup_idx: index("agent_phone_contacts_lookup_idx").on(
      table.provider,
      table.contact_identifier,
      table.is_active,
      table.last_contacted_at,
    ),
    agent_idx: index("agent_phone_contacts_agent_idx").on(table.agent_id),
    organization_idx: index("agent_phone_contacts_organization_idx").on(table.organization_id),
    user_idx: index("agent_phone_contacts_user_idx").on(table.user_id),
  }),
);

export type AgentPhoneContact = InferSelectModel<typeof agentPhoneContacts>;
export type NewAgentPhoneContact = InferInsertModel<typeof agentPhoneContacts>;
