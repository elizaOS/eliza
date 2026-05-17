import type { StreamEventEnvelope } from "../api/client";
export type AutonomyRunHealthStatus =
  | "ok"
  | "gap_detected"
  | "recovered"
  | "partial";
export interface AutonomyRunHealth {
  runId: string;
  status: AutonomyRunHealthStatus;
  lastSeq: number | null;
  missingSeqs: number[];
  gapCount: number;
  lastGapAt?: number;
  recoveredAt?: number;
  partialAt?: number;
}
export type AutonomyRunHealthMap = Record<string, AutonomyRunHealth>;
export interface AutonomyEventStore {
  eventsById: Record<string, StreamEventEnvelope>;
  eventOrder: string[];
  runIndex: Record<string, Record<number, string>>;
  watermark: string | null;
}
export interface MergeAutonomyEventsOptions {
  existingEvents?: StreamEventEnvelope[];
  store?: AutonomyEventStore;
  incomingEvents: StreamEventEnvelope[];
  runHealthByRunId: AutonomyRunHealthMap;
  maxEvents?: number;
  replay?: boolean;
}
export interface MergeAutonomyEventsResult {
  store: AutonomyEventStore;
  events: StreamEventEnvelope[];
  latestEventId: string | null;
  runHealthByRunId: AutonomyRunHealthMap;
  insertedCount: number;
  duplicateCount: number;
  runsWithNewGaps: string[];
  runsRecovered: string[];
  hasUnresolvedGaps: boolean;
}
export interface AutonomyGapReplayRequest {
  runId: string;
  fromSeq: number;
  missingSeqs: number[];
}
export declare function buildAutonomyGapReplayRequests(
  runHealthByRunId: AutonomyRunHealthMap,
  store: AutonomyEventStore,
): AutonomyGapReplayRequest[];
export declare function hasPendingAutonomyGaps(
  runHealthByRunId: AutonomyRunHealthMap,
): boolean;
export declare function markPendingAutonomyGapsPartial(
  runHealthByRunId: AutonomyRunHealthMap,
  ts?: number,
): AutonomyRunHealthMap;
export declare function mergeAutonomyEvents({
  existingEvents,
  store,
  incomingEvents,
  runHealthByRunId,
  maxEvents,
  replay,
}: MergeAutonomyEventsOptions): MergeAutonomyEventsResult;
//# sourceMappingURL=autonomy.d.ts.map
