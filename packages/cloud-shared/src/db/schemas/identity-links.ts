import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Identity links (Wave C).
 *
 * Persistent backing for the `areEntitiesLinked` adapter on
 * SensitiveRequestIdentityAuthorizationAdapter. Each row asserts that two
 * entity ids reference the same person under an optional provider context
 * (e.g. a Discord user-id linked to a cloud user-id via OAuth). The
 * authorization layer queries this table to satisfy
 * `owner_or_linked_identity` policies without leaning on connector-specific
 * stubs.
 */
export const IDENTITY_LINK_SOURCES = ["oauth", "manual", "wallet"] as const;
export type IdentityLinkSource = (typeof IDENTITY_LINK_SOURCES)[number];

export const identityLinks = pgTable(
  "identity_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    left_entity_id: text("left_entity_id").notNull(),
    right_entity_id: text("right_entity_id").notNull(),
    provider: text("provider"),
    source: text("source").$type<IdentityLinkSource>().notNull().default("manual"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unique_pair: uniqueIndex("idx_identity_links_unique_pair").on(
      table.left_entity_id,
      table.right_entity_id,
      table.provider,
    ),
    left_idx: index("idx_identity_links_left").on(table.left_entity_id),
    right_idx: index("idx_identity_links_right").on(table.right_entity_id),
    org_user_idx: index("idx_identity_links_org_user").on(table.organization_id, table.user_id),
    source_check: check(
      "identity_links_source_check",
      sql`${table.source} IN ('oauth','manual','wallet')`,
    ),
  }),
);

export type IdentityLinkRow = InferSelectModel<typeof identityLinks>;
export type NewIdentityLink = InferInsertModel<typeof identityLinks>;
