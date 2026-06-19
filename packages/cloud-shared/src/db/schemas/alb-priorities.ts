/**
 * ALB priorities table schema.
 *
 * Tracks ALB listener rule priorities to ensure uniqueness across all user deployments.
 * ALB priorities must be unique integers between 1 and 50,000.
 *
 * NOTE: Each user can have multiple projects, each with its own priority.
 * The unique key is (userId, projectName).
 */

import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const albPriorities = pgTable(
  "alb_priorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    projectName: text("project_name").notNull().default("default"),
    priority: integer("priority").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("alb_priorities_user_project_idx").on(table.userId, table.projectName)],
);

export type AlbPriority = typeof albPriorities.$inferSelect;
export type NewAlbPriority = typeof albPriorities.$inferInsert;
