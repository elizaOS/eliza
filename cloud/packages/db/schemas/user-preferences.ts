import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * User preferences table schema.
 *
 * Stores non-essential user profile preferences and notification settings.
 * Split from the main users table to reduce row size on the heavily-read core table.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),

    nickname: text("nickname"),
    work_function: text("work_function"),
    preferences: text("preferences"),
    response_notifications: boolean("response_notifications").default(true),
    email_notifications: boolean("email_notifications").default(true),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_idx: index("user_preferences_user_idx").on(table.user_id),
    work_function_idx: index("user_preferences_work_function_idx").on(table.work_function),
  }),
);

// Type inference
export type UserPreference = InferSelectModel<typeof userPreferences>;
export type NewUserPreference = InferInsertModel<typeof userPreferences>;
