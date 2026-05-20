import {
  doublePrecision,
  index,
  integer,
  json,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * ScamBench human evaluation responses.
 *
 * Each row is one participant's complete evaluation session (10-60 scenarios).
 * Individual per-scenario responses are stored in the `responses` JSON column.
 */
export const scambenchSessions = pgTable(
  "ScamBenchSession",
  {
    id: text("id").primaryKey(), // uuid
    participantId: text("participantId").notNull(), // user-chosen or generated
    /** Optional Feed user ID if authenticated */
    userId: text("userId"),
    /** 'web' | 'mturk' | 'feed' | 'api' */
    source: text("source").notNull().default("web"),
    /** MTurk assignment ID if from Mechanical Turk */
    mturkAssignmentId: text("mturkAssignmentId"),
    mturkHitId: text("mturkHitId"),
    mturkWorkerId: text("mturkWorkerId"),
    scenarioCount: integer("scenarioCount").notNull(),
    overallAccuracy: doublePrecision("overallAccuracy").notNull(),
    attackAccuracy: doublePrecision("attackAccuracy").notNull(),
    legitimateAccuracy: doublePrecision("legitimateAccuracy").notNull(),
    avgReadTimeMs: doublePrecision("avgReadTimeMs").notNull(),
    avgResponseTimeMs: doublePrecision("avgResponseTimeMs").notNull(),
    /** Total wall-clock duration of the session */
    totalDurationMs: doublePrecision("totalDurationMs"),
    /** Full per-scenario response array */
    responses: json("responses").notNull().$type<ScamBenchResponse[]>(),
    /** Browser user-agent for deduplication */
    userAgent: text("userAgent"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("scambench_session_participant_idx").on(table.participantId),
    index("scambench_session_source_idx").on(table.source),
    index("scambench_session_created_idx").on(table.createdAt),
  ],
);

export interface ScamBenchResponse {
  scenarioId: string;
  scenarioName?: string;
  category: string;
  intent: "attack" | "legitimate";
  difficulty: number;
  register: string;
  channel: string;
  chosenAction: string;
  expectedSafeActions: string[];
  correct: boolean;
  explanation: string;
  readTimeMs: number;
  responseTimeMs: number;
  totalTimeMs: number;
  timestamp: string;
}
