/**
 * Agent Budgets Schema
 *
 * Provides dedicated credit pools for agents running autonomously.
 * This prevents unlimited spending from developer's org credits.
 *
 * Key features:
 * - Allocated budget per agent
 * - Daily spending limits
 * - Auto-refill from org when depleted
 * - Pause on depletion
 * - Audit trail of all transactions
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";

// ============================================================================
// AGENT BUDGETS TABLE
// ============================================================================

/**
 * Agent budget allocation and spending tracking.
 *
 * Each agent can have a dedicated credit budget separate from the
 * organization's main balance. This enables:
 * - Spending limits for autonomous agents
 * - Per-agent cost tracking
 * - Auto-pause when budget depleted
 * - Auto-refill from org credits
 */
export const agentBudgets = pgTable(
  "agent_budgets",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Agent and owner
    agent_id: uuid("agent_id")
      .notNull()
      .unique()
      .references(() => userCharacters.id, { onDelete: "cascade" }),
    owner_org_id: uuid("owner_org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Budget allocation (in USD)
    allocated_budget: numeric("allocated_budget", { precision: 12, scale: 4 })
      .notNull()
      .default("0.0000"),
    spent_budget: numeric("spent_budget", { precision: 12, scale: 4 }).notNull().default("0.0000"),

    // Daily limits (in USD)
    daily_limit: numeric("daily_limit", { precision: 10, scale: 4 }),
    daily_spent: numeric("daily_spent", { precision: 10, scale: 4 }).notNull().default("0.0000"),
    daily_reset_at: timestamp("daily_reset_at"),

    // Auto-refill settings
    auto_refill_enabled: boolean("auto_refill_enabled").notNull().default(false),
    auto_refill_amount: numeric("auto_refill_amount", {
      precision: 10,
      scale: 4,
    }),
    auto_refill_threshold: numeric("auto_refill_threshold", {
      precision: 10,
      scale: 4,
    }),
    last_refill_at: timestamp("last_refill_at"),

    // Pause controls
    is_paused: boolean("is_paused").notNull().default(false),
    pause_on_depleted: boolean("pause_on_depleted").notNull().default(true),
    pause_reason: text("pause_reason"),
    paused_at: timestamp("paused_at"),

    // Alert settings
    low_budget_threshold: numeric("low_budget_threshold", {
      precision: 10,
      scale: 4,
    }).default("5.0000"),
    low_budget_alert_sent: boolean("low_budget_alert_sent").notNull().default(false),

    // Metadata
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    agent_idx: uniqueIndex("agent_budgets_agent_idx").on(table.agent_id),
    owner_org_idx: index("agent_budgets_owner_org_idx").on(table.owner_org_id),
    paused_idx: index("agent_budgets_paused_idx").on(table.is_paused),
  }),
);

// ============================================================================
// AGENT BUDGET TRANSACTIONS TABLE
// ============================================================================

/**
 * Audit trail of all budget transactions.
 *
 * Every credit/debit to an agent's budget is recorded here for:
 * - Audit compliance
 * - Debugging
 * - Usage analytics
 * - Billing reconciliation
 */
export const agentBudgetTransactions = pgTable(
  "agent_budget_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    budget_id: uuid("budget_id")
      .notNull()
      .references(() => agentBudgets.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => userCharacters.id, { onDelete: "cascade" }),

    // Transaction details
    type: text("type").notNull(), // "allocation", "deduction", "refill", "refund", "adjustment"
    amount: numeric("amount", { precision: 12, scale: 4 }).notNull(), // Positive for credits, negative for debits

    // Balance after transaction
    balance_after: numeric("balance_after", {
      precision: 12,
      scale: 4,
    }).notNull(),
    daily_spent_after: numeric("daily_spent_after", {
      precision: 10,
      scale: 4,
    }),

    // Context
    description: text("description").notNull(),
    operation_type: text("operation_type"), // "inference", "image_gen", "mcp_call", "a2a_call", etc.
    model: text("model"),
    tokens_used: numeric("tokens_used", { precision: 12, scale: 0 }),

    // Source reference (for tracing)
    source_type: text("source_type"), // "org_transfer", "auto_refill", "usage", etc.
    source_id: text("source_id"), // Reference to source transaction/operation

    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    budget_idx: index("agent_budget_txns_budget_idx").on(table.budget_id),
    agent_idx: index("agent_budget_txns_agent_idx").on(table.agent_id),
    type_idx: index("agent_budget_txns_type_idx").on(table.type),
    created_at_idx: index("agent_budget_txns_created_at_idx").on(table.created_at),
  }),
);

// ============================================================================
// TYPES
// ============================================================================

export type AgentBudget = InferSelectModel<typeof agentBudgets>;
export type NewAgentBudget = InferInsertModel<typeof agentBudgets>;
export type AgentBudgetTransaction = InferSelectModel<typeof agentBudgetTransactions>;
export type NewAgentBudgetTransaction = InferInsertModel<typeof agentBudgetTransactions>;
