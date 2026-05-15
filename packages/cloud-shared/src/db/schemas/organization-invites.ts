import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Organization invites table schema.
 *
 * Manages invitations to join organizations with token-based authentication.
 */
export const organizationInvites = pgTable(
  "organization_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    inviter_user_id: uuid("inviter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    invited_email: text("invited_email").notNull(),
    invited_role: text("invited_role").notNull(),

    token_hash: text("token_hash").notNull().unique(),
    expires_at: timestamp("expires_at").notNull(),

    status: text("status").notNull().default("pending"),
    accepted_at: timestamp("accepted_at"),
    accepted_by_user_id: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_idx: index("organization_invites_org_id_idx").on(table.organization_id),
    email_idx: index("organization_invites_email_idx").on(table.invited_email),
    token_idx: index("organization_invites_token_idx").on(table.token_hash),
    status_idx: index("organization_invites_status_idx").on(table.status),
  }),
);

export type OrganizationInvite = InferSelectModel<typeof organizationInvites>;
export type NewOrganizationInvite = InferInsertModel<typeof organizationInvites>;
