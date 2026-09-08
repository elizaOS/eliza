/** Stores revocable Outreachr credentials and a unique fence against app-code replay. */
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { users } from "./users";

export const outreachrDelegations = pgTable(
  "outreachr_delegations",
  {
    token_hash: text("token_hash").primaryKey(),
    authorization_code_hash: text("authorization_code_hash").notNull().unique(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    registration_digest: text("registration_digest").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("outreachr_delegations_expiry_idx").on(table.expires_at)],
);
