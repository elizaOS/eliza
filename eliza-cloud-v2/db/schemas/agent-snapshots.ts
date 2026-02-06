/**
 * Agent snapshots table schema.
 *
 * Stores point-in-time snapshots of agent state (memories, config,
 * workspace files) for backup, freeze/resume, and pre-eviction purposes.
 */

import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { organizations } from "./organizations";
import { containers } from "./containers";

export const agentSnapshots = pgTable(
  "agent_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    container_id: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    /** manual: user-triggered, auto: periodic backup, pre-eviction: billing system */
    snapshot_type: text("snapshot_type").notNull().default("manual"),

    /** URL to the snapshot data in cloud storage (Vercel Blob or S3). */
    storage_url: text("storage_url").notNull(),

    /** Size of the snapshot data in bytes. */
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),

    /** Agent configuration at the time of snapshot (character, plugins, etc.). */
    agent_config: jsonb("agent_config")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    /** Arbitrary metadata (trigger, frozen timestamp, etc.). */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    container_idx: index("agent_snapshots_container_idx").on(table.container_id),
    org_idx: index("agent_snapshots_org_idx").on(table.organization_id),
    type_idx: index("agent_snapshots_type_idx").on(table.snapshot_type),
    created_idx: index("agent_snapshots_created_idx").on(table.created_at),
  }),
);

export type AgentSnapshot = InferSelectModel<typeof agentSnapshots>;
export type NewAgentSnapshot = InferInsertModel<typeof agentSnapshots>;
