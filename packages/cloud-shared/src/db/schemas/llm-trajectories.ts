import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * LLM call trajectory table.
 *
 * Stores every LLM call that passes through Eliza Cloud for training data
 * collection. Each row is a single LLM invocation with full prompt/response
 * context.
 *
 * Used by the fine-tuning pipeline to:
 * 1. Collect real-world trajectories for supervised tuning
 * 2. Analyze model usage patterns per step (shouldRespond, planner, response)
 * 3. Build evaluation datasets from production traffic
 */
export const llmTrajectories = pgTable(
  "llm_trajectories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    api_key_id: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),

    // Call identity
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    /** Pipeline step: should_respond, planner, response, media_description, etc. */
    purpose: text("purpose"),
    request_id: text("request_id"),

    // Trajectory content (when trajectory_payload_storage = 'r2', prompts live in R2 at trajectory_payload_key)
    system_prompt: text("system_prompt"),
    user_prompt: text("user_prompt"),
    response_text: text("response_text"),
    /** `inline` = prompts stored in columns above; `r2` = JSON payload at trajectory_payload_key */
    trajectory_payload_storage: text("trajectory_payload_storage").notNull().default("inline"),
    /** R2 object key (S3-style path within bucket), when storage is r2 */
    trajectory_payload_key: text("trajectory_payload_key"),

    // Token metrics
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    total_tokens: integer("total_tokens").notNull().default(0),

    // Cost tracking
    input_cost: numeric("input_cost", { precision: 12, scale: 6 }).default("0.000000"),
    output_cost: numeric("output_cost", { precision: 12, scale: 6 }).default("0.000000"),
    total_cost: numeric("total_cost", { precision: 12, scale: 6 }).default("0.000000"),

    // Performance
    latency_ms: integer("latency_ms"),

    // Status
    is_successful: boolean("is_successful").notNull().default(true),
    error_message: text("error_message"),

    // Extensibility
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_created_idx: index("llm_trajectories_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    org_model_idx: index("llm_trajectories_org_model_idx").on(table.organization_id, table.model),
    purpose_idx: index("llm_trajectories_purpose_idx").on(table.purpose),
    org_purpose_created_idx: index("llm_trajectories_org_purpose_created_idx").on(
      table.organization_id,
      table.purpose,
      table.created_at,
    ),
  }),
);

export type LlmTrajectory = InferSelectModel<typeof llmTrajectories>;
export type NewLlmTrajectory = InferInsertModel<typeof llmTrajectories>;
