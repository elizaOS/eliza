import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../types";
import { users } from "./users";

/**
 * UserAgentConfig - Agent configuration for users who have enabled agent features.
 * Extracted from users table to optimize for the common case (users without agents).
 * Only created when a user enables agent functionality.
 */
export const userAgentConfigs = pgTable(
  "UserAgentConfig",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().unique(),

    // Agent personality and behavior
    personality: text("personality"),
    systemPrompt: text("system"),
    tradingStrategy: text("tradingStrategy"),
    style: json("style").$type<JsonValue>(),
    messageExamples: json("messageExamples").$type<JsonValue>(),
    personaPrompt: text("personaPrompt"),

    // Goals and constraints
    goals: json("goals").$type<JsonValue>(),
    directives: json("directives").$type<JsonValue>(),
    constraints: json("constraints").$type<JsonValue>(),

    // Agent settings
    planningHorizon: text("planningHorizon").notNull().default("single"),
    riskTolerance: text("riskTolerance").notNull().default("medium"),
    maxActionsPerTick: integer("maxActionsPerTick").notNull().default(3),
    modelTier: text("modelTier").notNull().default("free"),

    // Autonomous behavior flags
    autonomousPosting: boolean("autonomousPosting").notNull().default(false),
    autonomousCommenting: boolean("autonomousCommenting")
      .notNull()
      .default(false),
    // autonomousTrading defaults to true - agents should trade by default per user feedback
    autonomousTrading: boolean("autonomousTrading").notNull().default(true),
    autonomousDMs: boolean("autonomousDMs").notNull().default(false),
    autonomousGroupChats: boolean("autonomousGroupChats")
      .notNull()
      .default(false),
    a2aEnabled: boolean("a2aEnabled").notNull().default(false),

    // Runtime state
    status: text("status").notNull().default("idle"),
    errorMessage: text("errorMessage"),
    lastTickAt: timestamp("lastTickAt", { mode: "date" }),
    lastChatAt: timestamp("lastChatAt", { mode: "date" }),

    // Timestamps
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("UserAgentConfig_userId_idx").on(table.userId),
    index("UserAgentConfig_status_idx").on(table.status),
    index("UserAgentConfig_autonomousTrading_idx").on(table.autonomousTrading),
  ],
);

// Relations
export const userAgentConfigsRelations = relations(
  userAgentConfigs,
  ({ one }) => ({
    user: one(users, {
      fields: [userAgentConfigs.userId],
      references: [users.id],
    }),
  }),
);

// Type exports
export type UserAgentConfig = typeof userAgentConfigs.$inferSelect;
export type NewUserAgentConfig = typeof userAgentConfigs.$inferInsert;
