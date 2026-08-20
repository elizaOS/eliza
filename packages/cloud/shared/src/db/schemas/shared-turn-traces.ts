// Defines the shared turn traces Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SharedRuntimeTimingReceipt } from "../../lib/services/shared-runtime/shared-runtime-timing";

/** Terminal outcome of a Shared turn as classified by the trace recorder. */
export type SharedTurnTraceFinishReason =
  | "reply"
  | "capability-wall"
  | "degraded"
  | "error"
  | "aborted";

/**
 * One compact stage in a Shared turn trace: a short machine name, an optional
 * measured duration, and — for action stages — the registered tool name.
 * Deliberately carries NO prompt, reply, or argument text.
 */
export type SharedTurnTraceStage = {
  name: string;
  durationMs?: number;
  tool?: string;
};

/** The `stages` jsonb payload: ordered stage list plus the turn's finish reason. */
export type SharedTurnTraceStages = {
  finishReason: SharedTurnTraceFinishReason;
  stages: SharedTurnTraceStage[];
  /** Content-free terminal runtime receipt captured by the same sampled row. */
  terminalTiming?: SharedRuntimeTimingReceipt;
};

/** Token counts mirrored from `SharedAgentTurnUsage` (numbers only, no text). */
export type SharedTurnTraceUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Sampled per-turn observability for Tier-0 "shared" agent turns, which run
 * with `enableTrajectories: false` (full trajectory capture costs latency and
 * money on the interactive hot path). Each row is a COMPACT off-path record —
 * stage names, durations, tool names, finish reason, token usage — and never
 * prompt or response text, so the table stays small and privacy-safe.
 *
 * Rows are written by the flag-gated, deterministically sampled recorder in
 * `lib/services/shared-runtime/shared-turn-trace-recorder.ts`. Like
 * `shared_runtime_history`, the table is deliberately decoupled from the
 * tenant/billing tables (no FK cascade) so the diagnostics path can never
 * block or ripple into a tenant-owned write; every read must still pin
 * `organization_id` in the repository.
 */
export const sharedTurnTraces = pgTable(
  "shared_turn_traces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    user_id: uuid("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    channel_id: text("channel_id"),
    trace_id: text("trace_id").notNull(),
    started_at: timestamp("started_at").notNull(),
    latency_ms: integer("latency_ms").notNull(),
    model: text("model").notNull(),
    usage: jsonb("usage").$type<SharedTurnTraceUsage>(),
    stages: jsonb("stages").$type<SharedTurnTraceStages>().notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_agent_created_idx: index("shared_turn_traces_org_agent_created_idx").on(
      table.organization_id,
      table.agent_id,
      table.created_at,
    ),
  }),
);

export type SharedTurnTraceRow = InferSelectModel<typeof sharedTurnTraces>;
export type NewSharedTurnTraceRow = InferInsertModel<typeof sharedTurnTraces>;
