// Defines the ad audience segments Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export type AdAudienceSegmentTargeting = {
  locations?: string[];
  age_min?: number;
  age_max?: number;
  genders?: ("male" | "female" | "all")[];
  interests?: string[];
  behaviors?: string[];
  custom_audiences?: string[];
  excluded_audiences?: string[];
  placements?: string[];
  languages?: string[];
};

export const adAudienceSegments = pgTable(
  "ad_audience_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_by_user_id: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    description: text("description"),
    targeting: jsonb("targeting").$type<AdAudienceSegmentTargeting>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("ad_audience_segments_organization_idx").on(table.organization_id),
    created_by_idx: index("ad_audience_segments_created_by_idx").on(table.created_by_user_id),
    created_at_idx: index("ad_audience_segments_created_at_idx").on(table.created_at),
  }),
);

export type AdAudienceSegment = InferSelectModel<typeof adAudienceSegments>;
export type NewAdAudienceSegment = InferInsertModel<typeof adAudienceSegments>;
