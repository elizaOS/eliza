import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";

export type AgentEventType =
  | "inference_started"
  | "inference_completed"
  | "inference_failed"
  | "deploy_started"
  | "deploy_completed"
  | "deploy_failed"
  | "container_started"
  | "container_stopped"
  | "health_check_failed"
  | "error"
  | "system";

export type AgentLogLevel = "info" | "error" | "warn" | "debug" | "system";

export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => userCharacters.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    event_type: text("event_type").$type<AgentEventType>().notNull(),
    level: text("level").$type<AgentLogLevel>().notNull().default("info"),
    message: text("message").notNull(),
    message_storage: text("message_storage").notNull().default("inline"),
    message_key: text("message_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    metadata_storage: text("metadata_storage").notNull().default("inline"),
    metadata_key: text("metadata_key"),
    duration_ms: text("duration_ms"),
    container_id: uuid("container_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    agent_idx: index("agent_events_agent_idx").on(table.agent_id),
    organization_idx: index("agent_events_organization_idx").on(table.organization_id),
    event_type_idx: index("agent_events_event_type_idx").on(table.event_type),
    level_idx: index("agent_events_level_idx").on(table.level),
    created_at_idx: index("agent_events_created_at_idx").on(table.created_at),
    agent_created_idx: index("agent_events_agent_created_idx").on(table.agent_id, table.created_at),
  }),
);

export type AgentEvent = InferSelectModel<typeof agentEvents>;
export type NewAgentEvent = InferInsertModel<typeof agentEvents>;
